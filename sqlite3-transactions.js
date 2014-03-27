var sys = require('sys'),
    events = require('events'),
    _ = require("underscore");


var prohibitedMethods = [
	'emit', 'addListener', 'setMaxListeners',
	'on', 'once', 'removeListener',
	'removeAllListeners', 'listeners',
	'prepare'
];

var lockMethods = {
	'exec': true,
	'run': true,
	'get': true,
	'all': true,
	'each': true,
	'map': true,
	'finalize': true,
	'reset': true,
};

/**
 * Add transaction support to a database.
 * It inherits all methods from the database and passes through
 * all events. Only one method is added - beginTransaction().
 *
 * The transaction database ensures that when transcation is running
 * no other queries are executed. And only one transcation can be running
 * at the same time. Everything else get queued and is executed later.
 *
 * var db = new TransactionDatabase(new require("node-sqlite3").Database(...));
 * db.beginTransaction(function(err, tr) {
 *     if (err) return console.log(err);
 *     
 *     tr.run(...);
 *     tr.run(...);
 *     tr.commit(function(err) {
 *         if (err) return console.log(err);
 *         // done
 *         db.close();
 *     });
 * });
 * ...
 *
 * This wrapper needs to know how to execute SQL statements on the database. The default
 * command is database.exec(statement, callback). If you want to use different method
 * pass in argument exec(database, statement, callback) and call the method yourself.
 * 
 *
 * @param {Object} database Some database, tested with node-sqlite3
 * @param {Function} exec(database, statement, callback) 
 * 
 */
function TransactionDatabase(database, exec) {
	this._lock = 0;
	this.db = database;
	this.queue = [];
	this.currentTransaction = null;

	this.db.serialize();

	if (_.isFunction(exec))
		this._exec = _.partial(exec, this.db);
	else
		this._exec = _.bind(this.db.exec, this.db);

	wrapObject(this, this, this.db);

	// automatic rollback on error
	this.db.on('error', function() {
		if (!_.isNull(this.currentTransaction))
			this.currentTransaction.rollback(function() {});
	});

	// wrap prepare - return wrapped object
	var self = this;
	this.prepare = function() {
		var oldStatement = self.db.prepare.apply(self.db, arguments);
		var newStatement = new events.EventEmitter();
		wrapObject(self, newStatement, oldStatement);
		return newStatement;
	};
}
sys.inherits(TransactionDatabase, events.EventEmitter);
module.exports.TransactionDatabase = TransactionDatabase;


function wrapObject(transactionDatabase, target, source) {
	// wrap all methods
	for (var method in source) {
		if (_.isFunction(source[method]) && _.indexOf(prohibitedMethods, method)<0)
			target[method] = wrapDbMethod(transactionDatabase, source, method);
	}

	// setup events
	events.EventEmitter.call(target);
	interceptEmit(target, source, _.bind(target.emit, target)); // pass through all events
}

/// Delay DB method if we are currently in transaction
function wrapDbMethod(transactionDatabase, object, method) {
	var locking = _.has(lockMethods, method);

	return function() {
		var args = arguments;

		if (locking) {
			// hijack the callback to implement locking
			var originalCallback;
			var newCallback = function() {
				if (transactionDatabase._lock<1) throw new Error("Locks are not ballanced. Sorry.");
				transactionDatabase._lock--;
				originalCallback.apply(this, arguments);
			};

			if (arguments.length>0 && _.isFunction(args[args.length-1])) {
				originalCallback = args[args.length-1];
				args[args.length-1] = newCallback;
			}
			else {
				originalCallback = function(e) {
					if (e) transactionDatabase.db.emit("error", e);
				};
				args[args.length] = newCallback;
				args.length++;
			}
		}

		if (_.isNull(transactionDatabase.currentTransaction)) {
			//console.log("wrapper - executing", method);
			if (locking)
				transactionDatabase._lock++;
			object[method].apply(object, args);
		}
		else {
			//console.log("wrapper - queuing", method);
			transactionDatabase.queue.push({
				type: locking ? 'lock' : 'simple',
				object: object,
				method: method,
				args: args
			});
		}
	};
}


/// intercept all events from emitter.
function interceptEmit(self, emitter, handler) {
	var oldEmit = emitter.emit;
	emitter.emit = function() {
		handler.apply(self, arguments);
		oldEmit.apply(emitter, arguments);
	};
}


TransactionDatabase.prototype._wait = function(callback) {
	var self = this;
	function check() {
		if (self._lock===0)
			callback();
		else
			setTimeout(check, 1);
	}
	check();
};


/**
 * Execute waiting items in the queue. The item can be either
 * a beginTransaction() or a query to underlying database.
 * beginTransaction() Starts the query and pauses the execution of the
 * queue. Queries are executed without waiting for them to finish - because
 * they were also added in parallel, this is not a problem.
 */
TransactionDatabase.prototype._runQueue = function() {
	while (this.queue.length>0) {
		var item = this.queue.shift();

		if (item.type=='lock')
			this._lock++;
		
		item.object[item.method].apply(item.object, item.args);

		if (item.type=='transaction')
			return;
	}
};


/**
 * Begins a transaction.
 * If DB has a transaction currently running it waits until waits
 * until this transaction finishes. The callback is called with
 * parameters callback(err, transaction).
 *
 * Transaction is just the underlying database object with extra methods
 * commit(callback) and rollback(callback). You MUST call either
 * commit() or rollback() before quiting the callback funciton.
 * Otherwise every query will just get queued and never executed.
 * Transaction is automatically rolled back on `error` event.
 *
 * db.beginTransaction(function(err, tr) {
 *   if (err) return console.log(err);
 *   
 *   // use the tr object to run statements in the transaction
 *   tr.run("INSERT ....");
 *
 *   // You MUST call commit() or rollback()
 *   tr.commit(function(err) {
 *     if (err) return console.log(err);
 *   });
 * });
 */
TransactionDatabase.prototype.beginTransaction = function(callback) {
	var self = this;

	if (!_.isNull(self.currentTransaction)) {
		//console.log("queing transaction");
		self.queue.push({
			type: 'transaction',
			object: self,
			method: 'beginTransaction',
			args: arguments
		});
		return;
	}
	
	// Prepare the transaction object.
	var tr = self.db;
	var finished = false;
	self.currentTransaction = tr;

	function finishTransaction(e, cb) {
		finished = true;
		self.currentTransaction = null;
		self._runQueue();
		cb(e);
	}

	tr.commit = function(cb) {
		if (finished) return cb(new Error("Transaction is already finished. Can't do commit()."));
		self._wait(function(err) {
			if (err) callback(err);
			self._exec("COMMIT;", function(err) {
				if (err)
					tr.rollback(function(/* ignoring the potential error of rollback */) { cb(err); });
				else
					finishTransaction(null, cb);
			});
		});
	};

	tr.rollback = function(cb) {
		if (finished) return cb(new Error("Transaction is already finished. Can't do rollback()."));
		self._wait(function(err) {
			if (err) callback(err);
			self._exec("ROLLBACK;", function(err) {
				finishTransaction(err, cb);
			});
		});
	};

	// Begin the transaction.
	self._wait(function(err) {
		if (err) finishTransaction(err, callback);
		self._exec("BEGIN;", function(err) {
			if (err) return callback(err);
			callback(null, tr);
		});
	});
	
	
};

