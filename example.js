var sqlite3 = require("sqlite3"),
	TransactionDatabase = require("sqlite3-transactions").TransactionDatabase;

// Wrap sqlite3 database
var db = new TransactionDatabase(
	new sqlite3.Database("test.sqlite", sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)
);

// Use db as normal sqlite3.Database object.
db.exec("CREATE TABLE ...", function(err) {
	// table created
});

// Begin a transaction.
db.beginTransaction(function(err, transaction) {
	// Now we are inside a transaction.
	// Use transaction as normal sqlite3.Database object.
	transaction.run("INSERT ...");


	// All calls db.exec(), db.run(), db.beginTransaction(), ... are
	// queued and executed after you do transaction.commit() or transaction.rollback()
	
	// This will be executed after the transaction is finished.
	database.run("INSERT ..."); 

	// Remember to .commit() or .rollback()
	transaction.commit();
	// or transaction.rollback()
});