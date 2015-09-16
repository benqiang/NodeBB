
'use strict';

var async = require('async'),
	nconf = require('nconf'),
	winston = require('winston'),

	uuid = require('uuid'),

	user = require('../user'),
	utils = require('../../public/src/utils'),
	translator = require('../../public/src/modules/translator'),
	plugins = require('../plugins'),
	db = require('../database'),
	meta = require('../meta'),
	emailer = require('../emailer');

(function(UserEmail) {

	UserEmail.exists = function(email, callback) {
		user.getUidByEmail(email.toLowerCase(), function(err, exists) {
			callback(err, !!exists);
		});
	};

	UserEmail.available = function(email, callback) {
		db.isSortedSetMember('email:uid', email.toLowerCase(), function(err, exists) {
			callback(err, !exists);
		});
	};

	UserEmail.sendValidationEmail = function(uid, email, callback) {
		callback = callback || function() {};
		//var confirm_code = utils.generateUUID(),
		var confirm_code = getConfirmCode(),
			confirm_link = nconf.get('url') + '/confirm/' + confirm_code;

		var emailInterval = 10;

		winston.verbose('confirm_link = ' + confirm_link);

		async.waterfall([
			function(next) {
				db.get('uid:' + uid + ':confirm:email:sent', next);
			},
			function(sent, next) {
				if (sent) {
					winston.verbose('error:confirm-email-already-sent');
					return next(new Error('[[error:confirm-email-already-sent, ' + emailInterval + ']]'));
				}
				db.set('uid:' + uid + ':confirm:email:sent', 1, next);
			},
			function(next) {
				db.pexpireAt('uid:' + uid + ':confirm:email:sent', Date.now() + (emailInterval * 60 * 1000), next);
			},
			function(next) {
				plugins.fireHook('filter:user.verify.code', confirm_code, next);
			},
			function(_confirm_code, next) {
				confirm_code = _confirm_code;
				db.setObject('confirm:' + confirm_code, {
					email: email.toLowerCase(),
					uid: uid
				}, next);
			},
			function(next) {
				db.expireAt('confirm:' + confirm_code, Math.floor(Date.now() / 1000 + 60 * 60 * 24), next);
			},
			function(next) {
				user.getUserField(uid, 'username', next);
			},
			function(username, next) {
				var title = meta.config.title || meta.config.browserTitle || '信托麦客';
				translator.translate('[[email:welcome-to, ' + title + ']]', meta.config.defaultLang, function(subject) {
					var data = {
						site_title: title,
						username: username,
						confirm_link: confirm_link,
						confirm_code: confirm_code,

						subject: '邮箱修改确认',
						template: 'email_modify',
						uid: uid
					};

					if (plugins.hasListeners('action:user.verify')) {
						plugins.fireHook('action:user.verify', {uid: uid, data: data});
						next();
					} else if (plugins.hasListeners('action:email.send')) {
						emailer.sendToEmail('email_modify', email, 'zh_CN', data, next);
					} else {
						winston.warn('No emailer to send verification email!');
						next();
					}
				});
			}
		], callback);
	};

	UserEmail.confirm = function(code, callback) {
		db.getObject('confirm:' + code, function(err, confirmObj) {
			if (err) {
				return callback(new Error('[[error:parse-error]]'));
			}

			if (confirmObj && confirmObj.uid && confirmObj.email) {
				async.series([
					async.apply(user.setUserField, confirmObj.uid, 'email:confirmed', 1),
					async.apply(user.setUserField, confirmObj.uid, 'email', confirmObj.email),
					async.apply(user.setUserField, confirmObj.uid, 'modify_email', ''),
					async.apply(db.delete, 'confirm:' + code)
				], function(err) {
					callback(err ? new Error('[[error:email-confirm-failed]]') : null, confirmObj.uid);
				});
			} else {
				callback(new Error('[[error:invalid-data]]'));
			}
		});
	};

	UserEmail.notifyModifySucByEmailReply = function(uid, callback) {

		async.waterfall([
			function(next) {
				user.getUserFields(uid, ['username', 'email'], next);
			},
			function(userData, next) {
				var title = meta.config.title || meta.config.browserTitle || '信托麦客';

				var data = {
					site_title: title,
					username: userData.username,
					subject: '信托麦客邮箱修改成功',
					template: 'email_modifysuc_reply'
				};
				emailer.sendToEmail('email_modifysuc_reply', userData.email, 'zh_CN', data, next);
			}

		], callback);

	};

	function getConfirmCode() {
		return 'extm' + md5(uuid.v4()) + 'extm';
	};

	function md5(data) {
		var Buffer = require("buffer").Buffer;
		var buf = new Buffer(data);
		var str = buf.toString("binary");
		var crypto = require("crypto");
		return crypto.createHash("md5").update(str).digest("hex");
	};

}(exports));
