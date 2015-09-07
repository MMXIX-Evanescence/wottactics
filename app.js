room_data = {} //room -> room_data map to be shared with clients

//generates unique id
function newUid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,
    function(c) {
      var r = Math.random() * 16 | 0,
        v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    }).toUpperCase();
}

var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var passport = require('passport');
var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// uncomment after placing your favicon in /public
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
//app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// creating new socket.io app
var io = require('socket.io')();
app.io = io;

//initialize openid
var openid = require('openid');
var url = require('url');
var querystring = require('querystring');
var relyingParty = new openid.RelyingParty(
	'', // Verification URL (yours)
	null, // Realm (optional, specifies realm for OpenID authentication)
	false, // Use stateless verification
	false, // Strict mode
	[]); // List of extensions to enable and include

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: {}
  });
});

// not pretty but oh so handy to not crash the server
process.on('uncaughtException', function (err) {
	console.error(err);
	console.trace();
});

function clean_up_room(room) {
	setTimeout( function() { //just in case nobody joins
		if (room_data[room]) {
			if (!io.sockets.adapter.rooms[room]) {
				if (Date.now() - room_data[room].last_join > 50000) {
					delete room_data[room];
				} else {
					clean_up_room(room); //try again
				}
			}
		}
	}, 60000);
}

//load mongo
var connection_string = '127.0.0.1:27017/wottactics';
var MongoClient = require('mongodb').MongoClient;
MongoClient.connect('mongodb://'+connection_string, function(err, db) {
	if(err) throw err;	
	
	function get_tactics(identity, game, cb) {
		if (identity) {
			var collection = db.collection(identity);
			var name_list = [];
			var tactics = collection.find({game:game}, {"sort" : [['date', 'desc']], name:1, date:1});
			tactics.each(function (err, tactic) {			
				if (tactic) {
					var game = 'wot';
					if (tactic.game) {
						game = tactic.game;
					}
					name_list.push([tactic.name, tactic.date, game]);
				} else {
					cb(name_list);
				}
			})
		}
	}

	function restore_tactic(identity, game, name, cb) {
		if (identity) {
			var collection = db.collection(identity);
			var tactics = collection.findOne({game:game, name:name}, function(err, result) {
				if (!err && result) { 
					var uid = newUid();
					room_data[uid] = {};
					room_data[uid].history = result.history;
					room_data[uid].userlist = {};
					room_data[uid].lost_users = {};
					room_data[uid].locked = true;
					room_data[uid].name = name;
					room_data[uid].game = game;
					room_data[uid].last_join = Date.now();
					clean_up_room(uid);
					cb(uid);
				}
			});
		}
	}
	
	function remove_tactic(identity, game, name) {
		var collection = db.collection(identity);
		var tactics = collection.remove({name:name, game:game});		
	}

	// initializing session middleware
	var Session = require('express-session');
	var MongoStore = require('connect-mongo')(Session);
	var session = Session({ secret: 'pass', resave: true, saveUninitialized: true, cookie: { expires: new Date(Date.now() + 14 * 86400 * 1000) }, store: new MongoStore({db: db}), rolling: true});
	app.use(session); // session support
	
	// Configuring Passport
	var OpenIDStrategy = require('passport-openid').Strategy;
	app.use(passport.initialize());
	app.use(passport.session());
	app.use(function(req, res, next) { //create a default user
		if (!req.session.passport.user) {
			req.session.passport.user = {};
			req.session.passport.user.id = newUid();
			req.session.passport.user.name = "Anonymous";
			req.session.save();			
		}
		next();
	});
	
	passport.use(new OpenIDStrategy({
			returnURL: function(req) { return "http://" + req.hostname + "/auth/openid/return";},
			passReqToCallback: true
		},
		function(req, identifier, done) {
			var user = {};
			if (req.session.passport && req.session.passport.user) {
				user.id = req.session.passport.user.id;
			} else {
				user.id = newUid();		
			}
			user.identity = identifier.split('/id/')[1].split("/")[0];
			user.name = user.identity.split('-')[1];
			done(null, user);
		}
	));

	passport.serializeUser(function(user, done) {
		done(null, user);
	});

	passport.deserializeUser(function(user, done) {
		done(null, user);
	});

	// session support for socket.io
	io.use(function(socket, next) {
	  session(socket.handshake, {}, next);
	});

	// setup routes
	var router = express.Router();
	router.get('/', function(req, res, next) {
	  req.session.game = 'wot';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user });
	});
	router.get('/aw.html', function(req, res, next) {
	  req.session.game = 'aw';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user });
	});
	router.get('/wows.html', function(req, res, next) {
	  req.session.game = 'wows';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user });
	});
	router.get('/blitz.html', function(req, res, next) {
	  req.session.game = 'blitz';
	  res.render('index', { game: req.session.game, 
							user: req.session.passport.user });
	});
	function planner_redirect(req, res, game) {
	  if (req.query.restore) {
		var uid = newUid();
		restore_tactic(req.session.passport.user.identity, req.session.game, req.query.restore, function (uid) {
			res.redirect(game+'planner.html?room='+uid);
		});
	  } else if (!req.query.room) {
		  res.redirect(game+'planner.html?room='+newUid());
	  }	else {
		  req.session.game = game;
		  res.render('planner', { game: req.session.game, 
								  user: req.session.passport.user });
	  }
	}
	router.get('/wotplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'wot');
	});
	router.get('/awplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'aw');
	});
	router.get('/wowsplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'wows');
	});
	router.get('/blitzplanner.html', function(req, res, next) {
	  planner_redirect(req, res, 'blitz');
	});
	router.get('/about.html', function(req, res, next) {
	  if (!req.session.game) {
		  req.session.game = 'wot';
	  }
	  res.render('about', { game: req.session.game, 
							user: req.session.passport.user });
	});
	router.get('/getting_started.html', function(req, res, next) {
	  if (!req.session.game) {
		req.session.game = 'wot';
	  }
	  res.render('getting_started', { game: req.session.game, 
									  user: req.session.passport.user });
	});
	router.get('/stored_tactics.html', function(req, res, next) {
	  if (!req.session.game) {
		req.session.game = 'wot';
	  }
	  if (req.session.passport.user.identity) {
		get_tactics(req.session.passport.user.identity, req.session.game, function(tactics) {
		  res.render('stored_tactics', { game: req.session.game, 
										 user: req.session.passport.user,
										 tactics: tactics });
		});
	  } else {
		  res.redirect('/');
	  }
	});
	router.post('/remove_tactic', function(req, res, next) {
		if (req.session.passport.user.identity) {
			remove_tactic(req.session.passport.user.identity, req.session.game, req.body.name);
		}
		return;
	});
	
	//authentication routes
	router.post('/auth/openid', function(req, res, next) {
		req.session.return_to = req.headers.referer;
		next();
	}, passport.authenticate('openid'));
	router.get('/auth/openid/return', passport.authenticate('openid'), function(req, res, next) {
		res.redirect(req.session.return_to);
		delete req.session.return_to;		
	});
	app.use('/', router); 
	
	// catch 404 and forward to error handler
	app.use(function(req, res, next) {
		var err = new Error('Not Found');
		console.log(req.url)
		err.status = 404;
		next(err);
	});
	
	//socket.io callbacks
	io.sockets.on('connection', function(socket) { 
		if (!socket.handshake.session.passport) {
			socket.handshake.session.passport = {};
		}
		
		// if (!socket.handshake.session.passport.user) {
			// socket.handshake.session.passport.user = {};
			// var user = socket.handshake.session.passport.user;
			// user.id = newUid();
			// user.name = "Anonymous";
			// socket.handshake.session.save();
		// }
		
		socket.on('error', function (err) {
			console.error(err);
			console.trace();
		});
		
		socket.on('join_room', function(room, game) {
			var new_room = false;
			if (!(room in room_data)) { 
				room_data[room] = {};
				room_data[room].history = {};
				room_data[room].userlist = {};
				room_data[room].lost_users = {};
				room_data[room].game = game;
				room_data[room].locked = true;
			}

			room_data[room].last_join = Date.now();
			var user = JSON.parse(JSON.stringify(socket.handshake.session.passport.user));

			if (room_data[room].userlist[user.id]) {
				//a user is already connected to this room in probably another tab, just increase a counter
				room_data[room].userlist[user.id].count++;
			} else {
				room_data[room].userlist[user.id] = user;
				room_data[room].userlist[user.id].count = 1;
				if (!io.sockets.adapter.rooms[room] || Object.keys(io.sockets.adapter.rooms[room]).length == 0) { //no users
					//we should make the first client the owner
					room_data[room].userlist[user.id].role = "owner";
				} else if (room_data[room].lost_users[user.id]) {
					//if a user was previously connected to this room and had a role, restore that role
					room_data[room].userlist[user.id].role = room_data[room].lost_users[user.id];
				}
				socket.broadcast.to(room).emit('add_user', room_data[room].userlist[user.id]);			
			}			
			socket.join(room);
			socket.emit('room_data', room_data[room], user.id);
		});

		socket.onclose = function(reason){
			//hijack the onclose event because otherwise we lose socket.rooms data
			var user = socket.handshake.session.passport.user;
			for (i = 1; i < socket.rooms.length; i++) { //first room is clients own little private room so we start at 1
				var room = socket.rooms[i];
				if (room_data[room] && room_data[room].userlist[user.id]) {
					if (room_data[room].userlist[user.id].count == 1) {
						socket.broadcast.to(room).emit('remove_user', user.id);
						if (room_data[room].userlist[user.id].role) {
							room_data[room].lost_users[user.id] = room_data[room].userlist[user.id].role;
						}
						delete room_data[room].userlist[user.id];
					} else {
						room_data[room].userlist[user.id].count--;
					}
				}				
				if (Object.keys(io.sockets.adapter.rooms[room]).length == 1) {	//we're the last one in the room and we're leaving
					clean_up_room(room);
				}
			}
			
			Object.getPrototypeOf(this).onclose.call(this,reason); //call original onclose
		}
		
		socket.on('create_entity', function(room, entity) {
			if (room_data[room] && entity) {
				room_data[room].history[entity.uid] = entity;
				socket.broadcast.to(room).emit('create_entity', entity);
			}
		});
		
		socket.on('drag', function(room, uid, x, y) {
			if (room_data[room] && room_data[room].history[uid]) {
				room_data[room].history[uid].x = x;
				room_data[room].history[uid].y = y;
				socket.broadcast.to(room).emit('drag', uid, x, y);
			}
		});

		socket.on('ping', function(room, x, y, color) {
			socket.broadcast.to(room).emit('ping', x, y, color);
		});

		socket.on('track', function(room, tracker) {
			socket.broadcast.to(room).emit('track', tracker);
		});
		
		socket.on('track_move', function(room, uid, delta_x, delta_y) {
			socket.broadcast.to(room).emit('track_move', uid, delta_x, delta_y);
		});
		
		socket.on('stop_track', function(room, uid) {
			socket.broadcast.to(room).emit('stop_track', uid);
		});
		
		socket.on('remove', function(room, uid) {
			if (room_data[room] && room_data[room].history[uid]) {
				delete room_data[room].history[uid];
				socket.broadcast.to(room).emit('remove', uid);
			}
		});

		socket.on('chat', function(room, message) {
			socket.broadcast.to(room).emit('chat', message);
		});
		
		socket.on('update_user', function(room, user) {
			if (room_data[room] && room_data[room].userlist) {
				room_data[room].userlist[user.id] = user;
				socket.broadcast.to(room).emit('add_user', user);
			}
		});

		socket.on('lock_room', function(room, is_locked) {
			if (room_data[room]) {
				room_data[room].locked = is_locked;
				socket.broadcast.to(room).emit('lock_room', is_locked);
			}
		});

		socket.on('store', function(room, name) {
			user = socket.handshake.session.passport.user;
			if (room_data[room] && user.identity) { //room exists, user is logged in
				var collection = db.collection(user.identity);
				room_data[room].name = name;
				collection.update({name:name}, {name:name, history:room_data[room].history, date:Date.now(), game:room_data[room].game}, {upsert: true});
			}
		});

		socket.on('delete_tactic', function(name) {
			var identity = socket.handshake.session.passport.user.identity;
			if (identity) {
				var collection = db.collection(identity);
				var tactics = collection.remove({name:name});
			}
		});
	});
});

module.exports = app;
