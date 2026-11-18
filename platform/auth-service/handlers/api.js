// Lambda auth-api: API Gateway sends /api/auth/* here.
const serverless = require('serverless-http');
module.exports.handler = serverless(require('../app'));
