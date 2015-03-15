var validator = require('is-my-json-valid');


var auth = validator({
  type: 'object',
  properties: {
    id: {
      type: 'string',
    },
    pass: {
      type: 'string',
    },
    device: {
      type: 'string',
    },
  },
  required: ['id', 'pass', 'device'],
});


var request = validator({
  type: 'object',
  oneOf: [
    {
      properties: {
        request: {
          pattern: /^get:tasks$/,
        },
      },
      required: ['request'],
    },
    {
      properties: {
        request: {
          pattern: /^put:tasks$/,
        },
        data: {
          type: 'array',
          items: {
            type: 'string',
          },
          minItems: 1,
        },
      },
      required: ['request', 'data'],
    },
  ],
});


module.exports = {
  auth: auth,
  request: request,
};
