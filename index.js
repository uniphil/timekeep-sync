var template = require('lodash').template;
var http = require('http');
var connect = require('connect');
var serveStatic = require('serve-static');
var redis = require('redis');
var ws = require('ws');
var results = require('results'),
    Ok = results.Ok,
    Err = results.Err,
    Some = results.Some,
    None = results.None;
var validators = require('./messages');


var c = {
  // websocket constants
  SERVER_PORT: 5050,
  AUTH_TIMEOUT: 1000,

  // close codes
  NO_BINARY_ALLOWED: [4000, 'Binary messages are not allowed :('],
  NOT_JSON: [4001, 'Message could not be parsed as JSON :('],
  BAD_MESSAGE: [4002, 'Message failed to validate :('],
  BAD_LOGIN: [4003, 'The supplied login credentials were not valid :('],
  TOO_SLOW: [4004, 'Did not hear back in time about our future... :('],
  TOO_MUCH_GARBAGE: [4005, 'Too many bad messages. It\'s just not working for us :('],

  DB_ERROR: [4500, 'There is a probem at our end, sorry! :('],

  BEST_WISHES: [4100, 'Later, friend :)'],
};

var r = {
  // redis key templates
  PASSWORD: template('passwords:<%= userid %>'),
  TASKS: template('tasks:<%= userid %>'),
  CHANNEL: template('channel:<%= userid %>'),
}

var app = connect();
app.use(serveStatic('./'));
var server = http.createServer(app)
server.listen(c.SERVER_PORT)


var wss = new ws.Server({server: server});
wss.on('error', (err) => console.error('WebSocket server error', err));
wss.on('connection', initAuth);


var redisClient = redis.createClient();
redisClient.on('error', (err) => console.error('Redis client error', err));


function initAuth(ws) {
  ws.on('message', challenge);

  var timer = setTimeout(() => ws.close.apply(ws, c.TOO_SLOW), c.AUTH_TIMEOUT);

  function challenge(message, flags) {
    clearTimeout(timer);
    blockBinary(message, flags)
      .andThen(parseJSON)
      .andThen(validateWith(validators.auth))
      .orElse((anyLastWords) => Err(ws.close.apply(ws, anyLastWords)))
      .andThen((clientMessage) =>
        tryAuth(clientMessage, (authorized) =>
          authorized.match({
            Ok: (friend) => {
              ws.send(JSON.stringify({_reqId: friend._reqId}));
              welcome(friend, ws);
            },
            Err: (why) => ws.close.apply(ws, why),
          })
        ));
    ws.removeListener('message', challenge);
  }
}


/**
 * Try to create a new user, falling back on authenticating an existing user.
 * This strategy avoids races between "does this user exist?" and "create".
 */
function tryAuth(authMessage, cb) {
  var passKey = r.PASSWORD({userid: authMessage.id});
  redisClient.set(passKey, authMessage.pass, 'NX',  // IMPORTANT -- ONLY create a user if they don't exist
    (err, res) => {
      if (err) {
        cb(Err(c.DB_ERROR));
      } else if (res !== null) {  // new user, woo!
        cb(Ok(authMessage));
      } else {  // exising user, try to authenticate
        redisClient.get(passKey, (err, res) => {
          if (err) {
            cb(Err(c.DB_ERROR));
          } else if (res === authMessage.pass) {
            cb(Ok(authMessage));
          } else {
            cb(Err(c.BAD_LOGIN));
          }
        });
      }
    });
}


function welcome(friend, ws) {
  ws.on('message', (message) => {
    parseJSON(message)
      .andThen(validateWith(validators.request))
      .andThen(requestRouter.bind(null, ws))
      .orElse((message) => {
        console.log('could not route message', message);
        ws.send(JSON.stringify({_reqId: message._reqId, result: 'failure :('}));
      });
  });
  setTimeout(() => {
    ws.send(JSON.stringify({_push: 'tasks', data: [1, 2, 3]}));
  }, 500);
}


function requestRouter(ws, message) {
  var task = {
    'get:tasks': getTasks,
  }[message.request];
  if (!task) {
    return Err(message);
  } else {
    task(message.data, (err, res) => {
      ws.send(JSON.stringify({_reqId: message._reqId, result: 'blahblahblah'}));
    });
    return Ok('routed');
  }
}

function getTasks(message, cb) {
  cb(1);
}


function blockBinary(message, flags) {
  if (flags.binary) {
    return Err(c.NO_BINARY_ALLOWED);
  }
  return Ok(message);
}

function parseJSON(message) {
  var messageObj;
  try {
    messageObj = JSON.parse(message);
  } catch (e) {
    return Err(c.NOT_JSON);
  }
  return Ok(messageObj);
}

function validateWith(validate) {
  return function(data) {
    if (validate(data)) {
      return Ok(data);
    } else {
      return Err(c.BAD_MESSAGE);
    }
  }
}



console.log('app loaded');
