var _ = require('lodash');
var ws = require('ws');
var http = require('http');
var redis = require('redis');
var bcrypt = require('bcrypt');
var connect = require('connect');
var serveStatic = require('serve-static');
var results = require('results'),
    Ok = results.Ok,
    Err = results.Err,
    Some = results.Some,
    None = results.None;
var validators = require('./messages');

// websocket constants
const SERVER_PORT = 5050;
const AUTH_TIMEOUT = 1000;

// req response codes
const OK = 4200;
const SERVER_ERR = 4500;

// close codes
const NO_BINARY_ALLOWED = [4000, 'Binary messages are not allowed :('];
const NOT_JSON = [4001, 'Message could not be parsed as JSON :('];
const BAD_MESSAGE = [4002, 'Message failed to validate :('];
const BAD_LOGIN = [4003, 'The supplied login credentials were not valid :('];
const TOO_SLOW = [4004, 'Did not hear back in time about our future... :('];
const TOO_MUCH_GARBAGE = [4005, 'Too many bad messages. It\'s just not working for us :('];
const DB_ERROR = [4550, 'There is a probem at our end, sorry! :('];
const BEST_WISHES = [4100, 'Later, friend :)'];


const r = {  // redis key templates
  AUTH: _.template('auths:<%= id %>'),
  TASKS: _.template('tasks:<%= id %>'),
  CHANNEL: _.template('channel:<%= id %>'),
};

var app = connect();
app.use(serveStatic('./'));
var server = http.createServer(app)
server.listen(SERVER_PORT)


var wss = new ws.Server({server: server});
wss.on('error', (err) => console.error('WebSocket server error', err));
wss.on('connection', initAuth);


var redisClient = redis.createClient();
redisClient.on('error', (err) => console.error('Redis client error', err));


function initAuth(ws) {
  ws.on('message', challenge);

  var timer = setTimeout(() => ws.close.apply(ws, TOO_SLOW), AUTH_TIMEOUT);

  function challenge(message, flags) {  // WARNING message contains unhashed pw
    clearTimeout(timer);
    blockBinary(message, flags)
      .andThen(parseJSON)
      .andThen(validateWith(validators.auth))
      .orElse((anyLastWords) => Err(ws.close.apply(ws, anyLastWords)))
      .andThen((clientMessage) =>
        tryCreateOrAuth(clientMessage, (authorized) =>
          authorized.match({
            Ok: (friend) => {
              ws.send(JSON.stringify({_reqId: friend._reqId, status: OK}));
              welcome(friend, ws);
            },
            Err: (why) => ws.close.apply(ws, why),
          })
        ));
    ws.removeListener('message', challenge);
  }
}


function cbMatch(matches) {
  return (err, res) => {
    return (err ? Err(err) : Ok(res)).match(matches)
  };
}
function cbOrErr(cb, ok) {
  return cbMatch({
    Err: (err) => cb(Err(err)),
    Ok: (res) => ok(res),
  });
}


/**
 * Try to create a new user, falling back on authenticating an existing user.
 * This strategy avoids races between "does this user exist?" and "create".
 */
function tryCreateOrAuth(authMessage, cb) {
  var dangerPlainPass = authMessage.pass,
      auth = _.omit(authMessage, 'pass'),
      authKey = r.AUTH(auth);

  // find out if we should create a new account or authenticate an existing one
  // (with 'NX', redis SET returns Nil if the key exists)
  redisClient.set(authKey, null, 'NX', cbOrErr(cb, (res) =>
      res === null ? tryAuth() : tryCreate()));

  function tryAuth() {
    redisClient.get(authKey, cbOrErr(cb, (savedHash) =>
      bcrypt.compare(dangerPlainPass, savedHash, cbOrErr(cb, (matched) =>
        matched ? cb(Ok(auth)) : cb(Err(BAD_LOGIN))))));
  }

  function tryCreate() {
    bcrypt.hash(dangerPlainPass, 8, cbOrErr(cb, (hashedPass) =>
      redisClient.set(authKey, hashedPass, cbOrErr(cb, () => cb(Ok(auth))))));
  }
}


function welcome(friend, ws) {

  // redis pubsub
  var updates = redis.createClient();
  updates.on('message', (c, message) => {
    ws.send(JSON.stringify({_push: 'tasks', data: message}));
  });
  updates.subscribe(r.CHANNEL(friend));

  ws.on('close', updates.quit.bind(updates));

  // websocket req handling
  ws.on('message', (message) => {
    var reqId = null,
        respCbs = {
          Ok: (resp) => ws.send(JSON.stringify(_.extend({status: OK}, resp, reqId))),
          Err: (err) => ws.send(JSON.stringify(_.extend({status: SERVER_ERR}, err, reqId))),
        };

    function extractReqId(obj) {
      reqId = _.pick(obj, '_reqId');
      return Ok(_.omit(obj, '_reqId'));
    }

    parseJSON(message)
      .andThen(extractReqId)
      .andThen(validateWith(validators.request))
      .andThen(requestRouter.bind(null, friend, respCbs))
      .orElse(respCbs.Err);
  });

}


function requestRouter(friend, respCbs, message) {
  var task = {
    'get:tasks': getTasks,
    'put:tasks': putTasks,
  }[message.request];
  if (!task) {
    return Err({data: 'nothing to do for ' + task});
  }
  task(friend, message, respCbs);
  return Ok('routed');
}

function getTasks(friend, mesasge, respCbs) {
  redisClient.lrange(r.TASKS(friend), 0, -1, cbMatch({
    Ok: (tasks) => respCbs.Ok({data: tasks}),
    Err: (err)  => respCbs.Err({data: 'redis :('}),
  }));
}

function putTasks(friend, message, respCbs) {
  redisClient.publish(r.CHANNEL(friend), message.data);
  redisClient.rpush([r.TASKS(friend)].concat(message.data), cbMatch({
    Ok: (res) => respCbs.Ok({data: res}),
    Err: (err) => respCbs.Err({data: 'redis :('}),
  }));
}


function blockBinary(message, flags) {
  // WARNING message may contain unhashed pw
  if (flags.binary) {
    return Err(NO_BINARY_ALLOWED);
  }
  return Ok(message);
}

function parseJSON(message) {
  // WARNING message may contain unhashed pw
  var messageObj;
  try {
    messageObj = JSON.parse(message);
  } catch (e) {
    return Err(NOT_JSON);
  }
  return Ok(messageObj);
}

function validateWith(validate) {
  return function(data) {
    // WARNING data may contain unhashed pw
    if (validate(data)) {
      return Ok(data);
    } else {
      return Err([data._reqId, BAD_MESSAGE]);
    }
  }
}



console.log('app loaded');
