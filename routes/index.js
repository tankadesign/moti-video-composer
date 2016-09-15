var express = require('express');
var path = require('path');
var router = express.Router();
var AWS = require('aws-sdk');
var unzip = require('unzip');
var events = require('events');
var ffmpeg = require('fluent-ffmpeg');
var firebase = require('firebase');
const fs = require('fs');

const tmpDir = '/tmp';
var credentials = new AWS.SharedIniFileCredentials({profile: 'default'});
AWS.config.credentials = credentials;
AWS.config.region = 'us-east-1';
var eventEmitter = new events.EventEmitter();
var downloadPath = '';
firebase.initializeApp({
	serviceAccount: './keys/fbServiceAccountCredentials.json',
	databaseURL: process.env.FIREBASE_DATABASE_URL
})
var db = firebase.database();
var s3 = new AWS.S3();

router.post('/process_video/:id', function(req, res, next) {
	var id = req.params.id;
	var uid = req.body.uid;
	
	var path = 'transcode/' + id;
	var ref = db.ref(path);
	ref.once("value", function (snapshot) {
		if (!snapshot.exists()) {
			ref.set({status: 'start', percentage: 0, url: 'https://s3.amazonaws.com/moti-video-composer/' + id + '.mp4', downloads: 0, discards: 0}, function (error) {
				if (error == null) {
					downloadZipAndProcess(id);
					res.json({status: 'transcode_begin'});
				} else {
					res.status(400).send(error);
				}
			})
		} else {
			res.status(400).send({error: 'transcoding has already begun'});
		}
	})

});
function updateState (id, status, callback) {
	var path = 'transcode/' + id;
	var ref = db.ref(path);
	if (callback == null) callback = function () {}
	ref.update({status: status}, callback);
}
function updatePercentage (id, percentage) {
	var path = 'transcode/' + id;
	var ref = db.ref(path);
	ref.update({percentage: percentage});
}
function downloadZipAndProcess (id) {
	fs.mkdtemp(tmpDir + path.sep, function (err, folder) {
		if (err) {
			updateState(id, 'error');
			console.log('failed to create temp dir');
		} else {
			downloadPath = folder + path.sep
			var folder = '45532082/' + id + '/';
			var zipPath = downloadPath + id + '.zip';
			var file = fs.createWriteStream(zipPath);
			file.on('end', function () {
				console.log('filestream end');
			});
			var params = {Bucket: 'motichat-tokbox-archives', Key: folder + 'archive.zip'};
			s3.getObject(params)
				.on('httpData', function(chunk) {
					file.write(chunk);
				})
				.on('httpDone', function() {
					file.end();
					updateState(id, 'unzip');
					unzipFile(id, function (error, data) {
						if (error == null) {
							console.log('file complete');
						} else {
							updateState(id, 'error');
						}
					});
				})
				.on('error', function(error, response) {
					updateState(id, 'error');
					console.log(error);
				})
				.send();
		}
	})
}

function unzipFile (id, callback) {
	var path = downloadPath + id;
	var file = fs.createReadStream(downloadPath + id + '.zip')
		.on('error', function (err) {
			console.log(err);
			updateState(id, 'error');
			callback(err, null);
		})
		.pipe(unzip.Extract({path: path})
		.on('close', function () {
			console.log('unzipped file');
			parseDescriptorFile(id, callback);
		})
	);
	
}
function parseDescriptorFile (id, callback) {
	var path = downloadPath + id;
	fs.readFile(downloadPath + id + '/' + id + '.json', 'utf-8', function (error, data) {
		if (error) {
			callback(error);
		} else {
			var json = JSON.parse(data);
			var video1 = downloadPath + id + '/' + json.files[0].filename;
			var video2 = downloadPath + id + '/' + json.files[1].filename;
			var conversionStartTime = (new Date()).getTime();
			var start1 = json.files[0].startTimeOffset;
			var start2 = json.files[1].startTimeOffset;
			var end1 = json.files[0].stopTimeOffset;
			var end2 = json.files[1].stopTimeOffset;
			var length1 = end1 - start1;
			var length2 = end2 - start2;
			var offset1 = 0;
			var offset2 = start2 - start1;
			if(offset2 < 0) {
				offset1 = start1 - start2;
				offset2 = 0;
			}
			convertToMP4(id, video1, video2, offset1, offset2, downloadPath + id + '.mp4', function (err, done) {
				fs.unlinkSync(downloadPath + id + '.zip');
				deleteFolderRecursive(downloadPath + id);
				if (done) {
					var conversionEndTime = (new Date()).getTime();
					var conversionTime = Math.round((conversionEndTime - conversionStartTime)/100) / 10
					console.log('time to convert: ' + conversionTime + 's');
					postVideoToS3(id);
				}
			});
			callback(null, {status: 'conversion started'});
		}
	});
}
function postVideoToS3 (id) {
	var file = fs.createReadStream(downloadPath + id + '.mp4')
	var params = {Bucket: 'moti-video-composer', Key: id + '.mp4', Body: file};
	s3.upload(params, function (err, data) {
		if (err) {
			console.log('upload error:', err);
		} else {
			updateState (id, 'complete', null);
			deleteFolderRecursive(downloadPath);
		}
	})
}
function convertToMP4 (id, inputPath1, inputPath2, offset1, offset2, outputPath, callback) {
	var offsetDiff = Math.abs(offset1 - offset2);
	var offsetThreshold = 100;
	var filters;
	if (offsetDiff < offsetThreshold) {
		console.log('offset is < ' + offsetThreshold + ', no trimming needed: ', offsetDiff);
		filters = [
 			{filter: 'crop', options: {w: 480, h: 320}, inputs: '0:v', outputs: 'cropped0'},
 			{filter: 'crop', options: {w: 480, h: 320}, inputs: '1:v', outputs: 'cropped1'},
 			{filter: 'pad', options: {w: 480, h: 640, x: 0, y: 0}, inputs: 'cropped0', outputs: 'composed1'},
 			{filter: 'overlay', options: {x: 0, y: 320}, inputs: ['composed1', 'cropped1'], outputs: 'final'},
 			{filter: 'amix', options: {inputs: 2}, inputs: ['0:a','1:a']},
		]
	} else {
		console.log('offset is ' + offsetDiff + ', trimming audio and video');
		filters = [
	 		{filter: 'trim', options: {start: offset2/1000}, inputs:'0:v', outputs: 'video1'},
	 		{filter: 'trim', options: {start: offset1/1000}, inputs:'1:v', outputs: 'video2'},
 			{filter: 'crop', options: {w: 480, h: 320}, inputs: 'video1', outputs: 'cropped0'},
 			{filter: 'crop', options: {w: 480, h: 320}, inputs: 'video2', outputs: 'cropped1'},
 			{filter: 'pad', options: {w: 480, h: 640, x: 0, y: 0}, inputs: 'cropped0', outputs: 'composed1'},
 			{filter: 'overlay', options: {x: 0, y: 320}, inputs: ['composed1', 'cropped1'], outputs: 'composed'},
	 		{filter: 'atrim', options: {start: offset2/1000}, inputs:'0:a', outputs: 'audio1'},
	 		{filter: 'atrim', options: {start: offset1/1000}, inputs:'1:a', outputs: 'audio2'},
 			{filter: 'amix', options: {inputs: 2}, inputs: ['audio1','audio2']},
	 		{filter: 'atrim', options: {start: offsetDiff/1000}, inputs:'audioMix'},
	 		{filter: 'trim', options: {start: offsetDiff/1000}, inputs:'composed', outputs: 'final'},
		]
	}
	updateState(id, 'encoding');
	ffmpeg()
		.input(inputPath1, {map: 0})
 		.input(inputPath2, {map: 1})
		.output(outputPath)
		.audioCodec('libfdk_aac')
		.videoCodec('libx264')
		.audioBitrate(96)
		.videoBitrate(1000)
 		.complexFilter(filters, 'final')
		.on('error', function (err) {
			console.log('An error occurred: ' + err.message);
			updateState(id, 'error');
			if (callback) callback(null, {});
		})
		.on('end', function () {
			console.log('Processing finished !');
			updateState (id, 'encoded', null)
			if (callback) callback(null, {});
		})
		.on('progress', function (progress) {
			console.log('Processing: ' + progress.percent + '% done');
			updatePercentage (id, progress.percent)
		})
		.run();
}
function deleteFolderRecursive (path) {
  if( fs.existsSync(path) ) {
    fs.readdirSync(path).forEach(function(file,index){
      var curPath = path + "/" + file;
      if(fs.lstatSync(curPath).isDirectory()) { // recurse
        deleteFolderRecursive(curPath);
      } else { // delete file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(path);
  }
}
module.exports = router;
