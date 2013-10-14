#sqlite3-transactions

Adds transactions support to [node-sqlite3](https://github.com/developmentseed/node-sqlite3).

## Background

Node-sqlite3 is a great way how to access a SQLite database but id doesn't provide support for transactions yet. The underlying SQLite database can handle transactions easily so you can still do:
```javascript
db.serialize(function() {
    db.exec("BEGIN");
    ...
    db.exec("COMMIT");
});
```

This works fine until you add an async operation between `BEGIN` and `COMMIT`. The problem is that node-sqlite3 uses single connection to the database and thus queries from other places can end up intermixing with each other messing up the transactions.

Sqlite3-transactions solves this problem by transparently locking the database while in a transaction. If database is locked all queries which don't belong to the transaction are queued and executed after the transaction is finished. As a bonus you got a clean nice API for transactions.

## Install
```
npm install sqlite3
npm install sqlite3-transactions
```

## Usage
```javascript
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
    
    // Feel free to do any async operations.
    someAsync(function() {
    
        // Remember to .commit() or .rollback()
	    transaction.commit(function(err) {
            if (err) return console.log("Sad panda :-( commit() failed.", err);
            console.log("Happy panda :-) commit() was successful.");
        );
	    // or transaction.rollback()
        
    });
});
```

I haven't mentioned one feature in the example - on `error` event automatic `rollback()` is performed on the current transaction.

## API
### database.beginTransaction(callback)
Call this method to start a transaction. The database is locked and all queries are queued until the transaction is over. `callback` receives two parameters `error` and `transaction`. Use `transaction` to perform operations directly with database. You must call `transaction.commit()` or `transaction.rollback()` to finish the transaction and unlock the database. You don't have to `rollback()` in the case:

 * there is and `error` passed to the callback.
 * there was an `error` event during the transaction.

### transaction.commit(callback)
Commits the transaction. The `callback(error)` is called after the transaction is committed. If `error` is set then the commit failed for some reason and rollback was performed instead.

Queued operations are executed after the actual commit but before the `callback`. This helps to prevent starvation.

### transaction.rollback(callback)
Rolls back the transaction. The `callback(error)`is called after the operation is completed.


## Important notes
Remember to call `commit()` or `rollback()` on each transaction otherwise you lock your DB forever.

sqlite3-transactions is in very early stage of development. Please help me test it. 