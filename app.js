var express = require('express');
var http = require('http');
var path = require('path');
var bodyParser = require('body-parser');
var enforce = require('express-sslify');
require('dotenv').config()

var app = express();
//app.use(enforce.HTTPS({ trustProtoHeader: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

var port = process.env.PORT || 8080;
app.set('port', port);

var router = express.Router();

/*
router.get('/', function (req, res) {
	res.json({message: 'Welcome to the API. Are you looking for something?'});
});
*/
	
app.use('/', router);

var routes = [
	'/',
];
routes.forEach(function (route) {
	app.use(route, require('./routes' + route));
});

//app.listen(port);
http.createServer(app).listen(app.get('port'), function () {
	console.log('Express server listening on port ' + app.get('port'));
});