/**
 * Tests for the listDatabasesForAllTenants command.
 */
import {arrayEq} from "jstests/aggregation/extras/utils.js";
import {configureFailPoint, kDefaultWaitForFailPointTimeout} from "jstests/libs/fail_point_util.js";
import {funWithArgs} from "jstests/libs/parallel_shell_helpers.js";

const kVTSKey = 'secret';

// Given the output from the listDatabasesForAllTenants command, ensures that the total size
// reported is the sum of the individual db sizes.
function verifySizeSum(listDatabasesOut) {
    assert(listDatabasesOut.hasOwnProperty("databases"));
    const dbList = listDatabasesOut.databases;
    let sizeSum = 0;
    for (let i = 0; i < dbList.length; i++) {
        sizeSum += dbList[i].sizeOnDisk;
    }
    assert.eq(sizeSum, listDatabasesOut.totalSize);
}

// Given the output from the listDatabasesForAllTenants command, ensures that only the names and
// tenantIds of the databases are listed
function verifyNameOnly(listDatabasesOut) {
    // Delete extra meta info only returned by shardsvrs.
    delete listDatabasesOut.lastCommittedOpTime;

    for (let field in listDatabasesOut) {
        assert(['totalSize', 'totalSizeMb'].every((f) => f != field), 'unexpected field ' + field);
    }
    listDatabasesOut.databases.forEach((database) => {
        for (let field in database) {
            assert(['name', 'tenantId'].some((f) => f == field),
                   'only expected name or tenantId but got: ' + field);
        }
    });
}

// creates 'num' databases on 'conn', each belonging to a different tenant
function createMultitenantDatabases(conn, tokenConn, num) {
    let tenantIds = [];
    let tokens = [];
    let expectedDatabases = [];

    for (let i = 0; i < num; i++) {
        // Randomly generate a tenantId
        let kTenant = ObjectId();
        tenantIds.push(kTenant.str);

        // Set the tenant token to create the user
        conn._setSecurityToken(_createTenantToken({tenant: kTenant}));

        // Create a user for kTenant and then set the security token on the connection.
        assert.commandWorked(conn.getDB('$external').runCommand({
            createUser: "readWriteUserTenant" + i.toString(),
            roles: [{role: 'readWriteAnyDatabase', db: 'admin'}]
        }));
        let token = _createSecurityToken(
            {user: "readWriteUserTenant" + i.toString(), db: '$external', tenant: kTenant},
            kVTSKey);
        tokens.push(token);
        tokenConn._setSecurityToken(token);

        // Create a collection for the tenant and then insert into it.
        const tokenDB = tokenConn.getDB('auto_gen_db_' + i.toString());
        assert.commandWorked(tokenDB.createCollection('coll' + i.toString()));

        expectedDatabases.push(
            {"name": 'auto_gen_db_' + i.toString(), "tenantId": kTenant, "empty": false});
    }
    // Reset token
    conn._setSecurityToken(undefined);
    return [tenantIds, tokens, expectedDatabases];
}

// Given the output from the listDatabasesForAllTenants command, ensures that the database entries
// are correct
function verifyDatabaseEntries(listDatabasesOut, expectedDatabases) {
    const fieldsToSkip = ['sizeOnDisk'];
    assert(
        arrayEq(expectedDatabases, listDatabasesOut.databases, undefined, undefined, fieldsToSkip),
        tojson(listDatabasesOut.databases));
}

// Check that command properly lists all databases created by users authenticated with a security
// token
function runTestCheckMultitenantDatabases(primary, tokenConn, numDBs) {
    const adminDB = primary.getDB("admin");

    // Add a root user that is unauthorized to run the command
    assert.commandWorked(adminDB.runCommand({createUser: 'admin', pwd: 'pwd', roles: ['root']}));

    // Create numDBs databases, each belonging to a different tenant
    const [tenantIds, tokens, expectedDatabases] =
        createMultitenantDatabases(primary, tokenConn, numDBs);

    // Check that all numDB databases were created of the proper size and include the correct
    // database entries
    let cmdRes = assert.commandWorked(
        adminDB.runCommand({listDatabasesForAllTenants: 1, filter: {name: /auto_gen_db_/}}));
    assert.eq(numDBs, cmdRes.databases.length);
    verifySizeSum(cmdRes);
    verifyDatabaseEntries(cmdRes, expectedDatabases);

    return [tenantIds, tokens];
}

// Check that a delay in publishing the database creation to the in-memory catalog doesn't prevent
// the database from being visible.
function runTestCheckSlowPublishMultitenantDb(primary, tenantId, tokenConn, token) {
    const adminDB = primary.getDB("admin");

    tokenConn._setSecurityToken(token);

    const slowPublishDb = "slow_publish_multitenant_db";
    const slowPublishColl = "coll";

    // List database should reflect an implicitly created database that has been committed but not
    // published into the local catalog yet. Use a failpoint to hang before publishing the catalog,
    // simulating a slow catalog publish.
    const failPoint = configureFailPoint(
        primary,
        "hangBeforePublishingCatalogUpdates",
        {tenant: ObjectId(tenantId), collectionNS: slowPublishDb + '.' + slowPublishColl});
    const shellFn = (token, dbName, collName) => {
        let shellConn = db.getSiblingDB("admin").getMongo();
        shellConn._setSecurityToken(token);
        db.getSiblingDB(dbName)[collName].createIndex({a: 1});
    };
    const waitDbCreate = startParallelShell(
        funWithArgs(shellFn, token, slowPublishDb, slowPublishColl), primary.port);
    failPoint.wait();

    // use to verify that the database entry is correct
    const expectedDatabase =
        [{"name": slowPublishDb, "tenantId": ObjectId(tenantId), "empty": true}];

    let cmdRes = assert.commandWorked(adminDB.runCommand(
        {listDatabasesForAllTenants: 1, filter: {$expr: {$eq: ["$name", slowPublishDb]}}}));
    assert.eq(1, cmdRes.databases.length);
    verifySizeSum(cmdRes);
    verifyDatabaseEntries(cmdRes, expectedDatabase);

    failPoint.off();
    waitDbCreate();

    // Reset token
    tokenConn._setSecurityToken(undefined);
}

// Test correctness of filter and nameonly options
function runTestCheckCmdOptions(primary, tenantIds, tokenConn, tokens) {
    const adminDB = primary.getDB("admin");

    // Create 5 databases to verify the correctness of filter and nameOnly
    tokenConn._setSecurityToken(tokens[0]);
    assert.commandWorked(tokenConn.getDB("jstest_list_databases_foo").createCollection("coll0"));
    tokenConn._setSecurityToken(tokens[1]);
    assert.commandWorked(tokenConn.getDB("jstest_list_databases_bar").createCollection("coll0"));
    tokenConn._setSecurityToken(tokens[2]);
    assert.commandWorked(tokenConn.getDB("jstest_list_databases_baz").createCollection("coll0"));
    tokenConn._setSecurityToken(tokens[3]);
    assert.commandWorked(tokenConn.getDB("jstest_list_databases_zap").createCollection("coll0"));

    // use to verify that the database entries are correct
    const expectedDatabases2 = [
        {"name": "jstest_list_databases_foo", "tenantId": ObjectId(tenantIds[0]), "empty": false},
        {"name": "jstest_list_databases_bar", "tenantId": ObjectId(tenantIds[1]), "empty": false},
        {"name": "jstest_list_databases_baz", "tenantId": ObjectId(tenantIds[2]), "empty": false},
        {"name": "jstest_list_databases_zap", "tenantId": ObjectId(tenantIds[3]), "empty": false}
    ];

    let cmdRes = assert.commandWorked(adminDB.runCommand(
        {listDatabasesForAllTenants: 1, filter: {name: /jstest_list_databases/}}));
    assert.eq(4, cmdRes.databases.length);
    verifySizeSum(cmdRes);
    verifyDatabaseEntries(cmdRes, expectedDatabases2);

    // Now only list databases starting with a particular prefix.
    cmdRes = assert.commandWorked(adminDB.runCommand(
        {listDatabasesForAllTenants: 1, filter: {name: /^jstest_list_databases_ba/}}));
    assert.eq(2, cmdRes.databases.length);
    verifySizeSum(cmdRes);

    // Now return the system admin database and tenants' admin databases.
    cmdRes = assert.commandWorked(
        adminDB.runCommand({listDatabasesForAllTenants: 1, filter: {name: "admin"}}));
    assert.eq(1 + tenantIds.length, cmdRes.databases.length, tojson(cmdRes.databases));
    verifySizeSum(cmdRes);

    // Now return only one tenant admin database.
    cmdRes = assert.commandWorked(adminDB.runCommand({
        listDatabasesForAllTenants: 1,
        filter: {name: "admin", tenantId: ObjectId(tenantIds[2])}
    }));
    assert.eq(1, cmdRes.databases.length, tojson(cmdRes.databases));
    verifySizeSum(cmdRes);

    // Now return only the names.
    cmdRes = assert.commandWorked(adminDB.runCommand({
        listDatabasesForAllTenants: 1,
        filter: {name: /^jstest_list_databases_/},
        nameOnly: true
    }));
    assert.eq(4, cmdRes.databases.length, tojson(cmdRes));
    verifyNameOnly(cmdRes);

    // Now return only the name of the zap database.
    cmdRes = assert.commandWorked(
        adminDB.runCommand({listDatabasesForAllTenants: 1, nameOnly: true, filter: {name: /zap/}}));
    assert.eq(1, cmdRes.databases.length, tojson(cmdRes));
    verifyNameOnly(cmdRes);

    // $expr in filter.
    cmdRes = assert.commandWorked(adminDB.runCommand({
        listDatabasesForAllTenants: 1,
        filter: {$expr: {$eq: ["$name", "jstest_list_databases_zap"]}}
    }));
    assert.eq(1, cmdRes.databases.length, tojson(cmdRes));
    assert.eq("jstest_list_databases_zap", cmdRes.databases[0].name, tojson(cmdRes));
}

// Test that invalid commands fail
function runTestInvalidCommands(primary) {
    const adminDB = primary.getDB("admin");
    const tokenConn = new Mongo(primary.host);

    // $expr with an unbound variable in filter.
    assert.commandFailed(adminDB.runCommand(
        {listDatabasesForAllTenants: 1, filter: {$expr: {$eq: ["$name", "$$unbound"]}}}));

    // $expr with a filter that throws at runtime.
    assert.commandFailed(
        adminDB.runCommand({listDatabasesForAllTenants: 1, filter: {$expr: {$abs: "$name"}}}));

    // No extensions are allowed in filters.
    assert.commandFailed(
        adminDB.runCommand({listDatabasesForAllTenants: 1, filter: {$text: {$search: "str"}}}));
    assert.commandFailed(adminDB.runCommand({
        listDatabasesForAllTenants: 1,
        filter: {
            $where: function() {
                return true;
            }
        }
    }));
    assert.commandFailed(adminDB.runCommand({
        listDatabasesForAllTenants: 1,
        filter: {a: {$nearSphere: {$geometry: {type: "Point", coordinates: [0, 0]}}}}
    }));

    // Remove internal user
    adminDB.dropUser("internalUsr");

    // Create and authenticate as an admin user with root role
    assert(adminDB.runCommand({createUser: 'admin', pwd: 'pwd', roles: ['root']}));
    assert(adminDB.auth("admin", "pwd"));

    // Check that user is not authorized to call the command
    let cmdRes = assert.commandFailedWithCode(
        adminDB.runCommand({listDatabasesForAllTenants: 1, filter: {name: /auto_gen_db_/}}),
        ErrorCodes.Unauthorized);

    // Add user authenticated with security token and check that they cannot run the command
    const kTenant = ObjectId();
    primary._setSecurityToken(_createTenantToken({tenant: kTenant}));
    assert.commandWorked(primary.getDB('$external').runCommand({
        createUser: "unauthorizedUsr",
        roles: [{role: 'readWriteAnyDatabase', db: 'admin'}]
    }));
    primary._setSecurityToken(undefined);
    tokenConn._setSecurityToken(
        _createSecurityToken({user: "unauthorizedUsr", db: '$external', tenant: kTenant}, kVTSKey));
    const tokenAdminDB = tokenConn.getDB("admin");
    cmdRes = assert.commandFailedWithCode(
        tokenAdminDB.runCommand({listDatabasesForAllTenants: 1, filter: {name: /auto_gen_db_/}}),
        ErrorCodes.Unauthorized);
}

function runTestsWithMultiTenancySupport() {
    const rst = new ReplSetTest({
        nodes: 2,
        nodeOptions: {
            auth: '',
            setParameter: {
                multitenancySupport: true,
                featureFlagSecurityToken: true,
                testOnlyValidatedTenancyScopeKey: kVTSKey,
            }
        }
    });
    rst.startSet({keyFile: 'jstests/libs/key1'});
    rst.initiate();

    const primary = rst.getPrimary();
    const adminDB = primary.getDB('admin');
    const tokenConn = new Mongo(primary.host);

    // Create internal system user that is authorized to run the command
    assert.commandWorked(
        adminDB.runCommand({createUser: 'internalUsr', pwd: 'pwd', roles: ['__system']}));
    assert(adminDB.auth("internalUsr", "pwd"));

    const numDBs = 5;
    const [tenantIds, tokens] = runTestCheckMultitenantDatabases(primary, tokenConn, numDBs);
    runTestCheckSlowPublishMultitenantDb(primary, tenantIds[0], tokenConn, tokens[0]);
    runTestCheckCmdOptions(primary, tenantIds, tokenConn, tokens);
    runTestInvalidCommands(primary);

    rst.stopSet();
}

function runTestNoMultiTenancySupport() {
    const rst = new ReplSetTest({
        nodes: 2,
        nodeOptions: {
            auth: '',
            setParameter: {
                multitenancySupport: false,
                featureFlagSecurityToken: true,
                testOnlyValidatedTenancyScopeKey: kVTSKey,
            }
        }
    });
    rst.startSet({keyFile: 'jstests/libs/key1'});
    rst.initiate();

    const primary = rst.getPrimary();
    const adminDB = primary.getDB('admin');

    assert.commandWorked(
        adminDB.runCommand({createUser: 'internalUsr', pwd: 'pwd', roles: ['__system']}));
    assert(adminDB.auth("internalUsr", "pwd"));

    assert.commandFailedWithCode(adminDB.runCommand({listDatabasesForAllTenants: 1}),
                                 ErrorCodes.CommandNotSupported);

    rst.stopSet();
}

runTestsWithMultiTenancySupport();
runTestNoMultiTenancySupport();
