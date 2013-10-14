var sqlite3 = require("sqlite3"),
	_ = require("underscore"),
	slide = require("slide"),
	fs = require("fs"),
	sys = require('sys'),
    events = require('events');

var TransactionDatabase = require("./sqlite3-transactions").TransactionDatabase;

var db;

var TEST_LENGTH = 20000;

function Runner (fn) {
	this.timer = null;
	this.fn = fn;
	events.EventEmitter.call(this);
}
sys.inherits(Runner, events.EventEmitter);

Runner.prototype.start = function(interval) {
	var self = this;

	self.stop();

	function check() {
		self.fn(function(err) {
			if (err)
				self.emit("error", err);
			else
				self.emit("success");
			if (!_.isNull(self.timer)) // if timer hasn't been stopped during fn() or during error handler
				self.timer = setTimeout(check, interval);
		});
	}
	self.timer = setTimeout(check, 1);
};

Runner.prototype.stop = function() {
	if (this.timer) {
		clearTimeout(this.timer);
		this.timer = null;
	}
};



function init(callback) {
	var self = this;

	var file = "./test.sqlite3";

	db = new TransactionDatabase(
		new sqlite3.Database(
			file,
			sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
			function(err) {
				if (err) return callback(err);
				initDatabase(callback);
			}
		)
	);
}

function initDatabase(callback) {
	db.exec(
		"CREATE TABLE IF NOT EXISTS data (" +
			"id INTEGER PRIMARY KEY AUTOINCREMENT, " +
			"t TEXT NOT NULL" +
		");" +
		"DELETE FROM data;",

		callback
	);
}


function insertData1(callback) {
	// start a transaction
	//console.log('==beginTransaction');
	db.beginTransaction(function(err, tr) {
		//console.log('  beginTransaction done', err);

		// do multiple inserts
		slide.asyncMap(
			['all', 'your', 'base', 'are', 'belong', 'to', 'us'],
			function(item, cb) {
				//console.log("    "+item);
				tr.run("INSERT INTO data (t) VALUES (?)", item, cb);
			},
			function(err) {
				// all done - now erase it all
				//console.log("==rollback");
				tr.rollback(function(e) {
					//console.log("==rollback done");
					callback(e);
				});
			}
		);
	});
}

function insertData2(callback) {
	// start a transaction
	//console.log('==beginTransaction');
	db.beginTransaction(function(err, tr) {
		var data = ['all', 'your', 'base', 'are', 'belong', 'to', 'us'];
		for (var i=0; i<data.length; ++i)
			tr.run("INSERT INTO data (t) VALUES (?)", data[i]);
		tr.rollback(function(e) {
			//console.log("==rollback done");
			callback(e);
		});
	});
}

var integer = 0;
function insertInteger(callback) {
	//console.log('INT ', integer);
	db.exec("INSERT INTO data (t) VALUES ('"+(integer++)+"')", function(err) {
		//console.log('INT done', integer);
		callback(err);
	});
}

function insertIntegerStatement(callback) {
	//console.log("INT", integer);
	var statement = db.prepare("INSERT INTO data (t) VALUES (?)");
	statement.bind(integer++);
	statement.run(function(err) {
		//console.log("INT done", integer-1);
		callback(err);
	});
}

function insertIntegerTransaction(callback) {
	//console.log('INT ', integer);
	db.beginTransaction(function(err, tr) {
		tr.exec("INSERT INTO data (t) VALUES ('"+(integer++)+"')", function(err) {
			if (err) return console.log(err);
			tr.commit(function(err) {
				//console.log('INT done', integer);
				callback(err);
			});
		});
	});
}

function checkConsistent(callback) {
	var self = this;
	db.all("SELECT * FROM data WHERE t-1 NOT IN (SELECT t FROM data)", function(err, rows) {
		var msg = "";
		for (var i=1; i<rows.length; ++i) { // skip first record - 0 has no predecessor
			var missingValue = rows[i].t-1;
			if (_.isNaN(missingValue))
				msg += "Not consistent - That shouldn't be here " + rows[i].t + "\n";
			else
				msg += "Not consistent - Missing "+missingValue + "\n";
		}

		if (rows.length>1)
			callback(new Error(msg));
		else
			callback(null);
	});
}

function test1(insertFn, integerFn, callback) {
	// Insert data in transaction and roll'em'back every 10ms
	var insertRunner = new Runner(insertFn);
	insertRunner.on("error", function(err) {
		console.log("insert error", err);
		process.exit(1);
	});
	insertRunner.start(10);

	// Insert increasing integers 0,1... every 9ms
	var integerRunner = new Runner(integerFn);
	insertRunner.on("error", function(err) {
		console.log("integer insert error", err);
		process.exit(1);
	});
	integerRunner.start(9);

	// Check if DB is consistent every 1s
	var consistentRunner = new Runner(checkConsistent);
	consistentRunner.on('error', function(err) {
		console.log(err);
		process.exit(1);
	});
	var checkNum = 0;
	consistentRunner.on('success', function() {
		console.log("Consistent", ++checkNum, "integer="+integer);
	});
	consistentRunner.start(1000);

	// do this stuff for 20s and then stop it
	setTimeout(function() {
		insertRunner.stop();
		integerRunner.stop();
		consistentRunner.stop();
		setTimeout(function() {
			db.close(callback);
		}, 500);
	}, TEST_LENGTH);
}

var tests = {
	'waiting for all queries in a transaction': _.partial(test1, insertData2, insertInteger),
	'concurency of transaction and queries': _.partial(test1, insertData1, insertInteger),
	'concurency of two transactions': _.partial(test1, insertData1, insertIntegerTransaction),
	'statement': _.partial(test1, insertData1, insertIntegerStatement),
};


var testsArray = [];
for(var iterKey in tests) {
	testsArray.push((function(key) {
		return function(cb) {
			init(function() {
				tests[key](function(err) {
					if (err)
						console.log("Test", key, "ERROR", err);
					else
						console.log("Test", key, "DONE");
					cb(err);
				});
			});
		};
	})(iterKey));
}
slide.chain(
	testsArray,
	function(e) {
		if (e) return console.log(e);
		console.log("ALL TESTS DONE");
	}
);



