
'use strict';

var async = require('async'),
	nconf = require('nconf'),
	request = require('request'),
	winston = require('winston'),

	uuid = require('uuid'),

	db = require('../database'),
	meta = require('../meta'),
	emailer = require('../emailer'),
	notifications = require('../notifications'),
	groups = require('../groups'),
	translator = require('../../public/src/modules/translator'),
	utils = require('../../public/src/utils');


module.exports = function(User) {

	User.addToApprovalQueue = function(userData, callback) {
		userData.userslug = utils.slugify(userData.username);
		async.waterfall([
			function(next) {
				User.isDataValid(userData, next);
			},
			function(next) {
				User.hashPassword(userData.password, next);
			},
			function(hashedPassword, next) {
				var data = {
					username: userData.username,
					email: userData.email,
					ip: userData.ip,
					hashedPassword: hashedPassword,

					// 添加自定义字段
					bq_registration_realname: userData.bq_registration_realname,
					bq_registration_company: userData.bq_registration_company,
					//bq_registration_company_email: userData.bq_registration_company_email,
					bq_registration_mobile: userData.bq_registration_mobile,
					bq_registration_wechat: userData.bq_registration_wechat,
					bq_reg_has_authenticated: userData.bq_reg_has_authenticated
				};

				db.setObject('registration:queue:name:' + userData.username, data, next);
			},
			function(next) {
				db.sortedSetAdd('registration:queue', Date.now(), userData.username, next);
			},
			function(next) {
				sendNotificationToAdmins(userData.username, next);
			}
		], callback);
	};

	function sendNotificationToAdmins(username, callback) {
		notifications.create({
			bodyShort: '[[notifications:new_register, ' + username + ']]',
			nid: 'new_register:' + username,
			path: '/admin/manage/registration'
		}, function(err, notification) {
			if (err) {
				return callback(err);
			}
			if (notification) {
				notifications.pushGroup(notification, 'administrators', callback);
			} else {
				callback();
			}
		});
	}


	// 管理员批准后，给用户发送确认邮件，并将信息转存到另一个列表中，并从注册队列中删除
	User.acceptRegistration = function(username, callback) {
		var uid = 0;
		var userData;
		//var host = 'http://localhost:4567/';
		var host = 'http://bbs.xintuomarket.com/';

		async.waterfall([
			function(next) {
				db.getObject('registration:queue:name:' + username, next);
			},
			function(_userData, next) {
				if (!_userData) {
					return callback(new Error('[[error:invalid-data]]'));
				}
				userData = _userData;

				// 新增字段 --- 认证code
				userData.confirm_code = getConfirmCode();

				User.createWaitingConfirmUser(userData, next);
			},
			function(_uid, next) {
				uid = _uid;
				next();
			},
			function(next) {
				var title = meta.config.title || meta.config.browserTitle || '信托麦客';
				translator.translate('[[email:welcome-to, ' + title + ']]', meta.config.defaultLang, function(subject) {
					var data = {
						site_title: title,
						username: username,
						subject: subject,
						template: 'registration_accepted',
						uid: uid,
						confirm_code: userData.confirm_code,
						confirm_url: host + 'user/confirm?code=' + userData.confirm_code
					};
					emailer.sendToEmail('registration_accepted', userData.email, 'zh_CN', data, next);
				});
			},
			function(next) {
				removeFromQueue(username, next);
			},
		], callback);
	};

	function markNotificationRead(username, callback) {
		var nid = 'new_register:' + username;
		async.waterfall([
			function (next) {
				groups.getMembers('administrators', 0, -1, next);
			},
			function (uids, next) {
				async.each(uids, function(uid, next) {
					notifications.markRead(nid, uid, next);
				}, next);
			}
		], callback);
	}

	User.rejectRegistration = function(username, callback) {
		async.waterfall([
			function(next) {
				db.getObject('registration:queue:name:' + username, next);
			},
			function(_userData, next) {
				var title = meta.config.title || meta.config.browserTitle || '信托麦客';

				var data = {
					site_title: title,
					username: username,
					subject: '信托麦客注册审核未通过',
					template: 'registration_rejected'
				};
				emailer.sendToEmail('registration_rejected', _userData.email, 'zh_CN', data, next);
			},
			function (next) {
				removeFromQueue(username, next);
			},
			function (next) {
				markNotificationRead(username, next);
			}

		], callback);
	};

	function removeFromQueue(username, callback) {
		async.parallel([
			async.apply(db.sortedSetRemove, 'registration:queue', username),
			async.apply(db.delete, 'registration:queue:name:' + username)
		], function(err, results) {
			callback(err);
		});
	}

	function removeFromWaitConfirmQueue(confirm_code, wuid, callback) {
		async.parallel([
			async.apply(db.sortedSetRemove, 'confirm_code:uid', confirm_code),
			async.apply(db.delete, 'waitingconfirm:user:' + wuid)
		], function(err, results) {
			callback(err);
		});
	}

	User.getRegistrationQueue = function(start, stop, callback) {
		var data;
		async.waterfall([
			function(next) {
				db.getSortedSetRevRangeWithScores('registration:queue', start, stop, next);
			},
			function(_data, next) {
				data = _data;
				var keys = data.filter(Boolean).map(function(user) {
					return 'registration:queue:name:' + user.value;
				});
				db.getObjects(keys, next);
			},
			function(users, next) {
				users.forEach(function(user, index) {
					if (user) {
						user.timestamp = utils.toISOString(data[index].score);
					}
				});

				//async.map(users, function(user, next) {
				//	if (!user) {
				//		return next(null, user);
				//	}
                //
				//	// temporary: see http://www.stopforumspam.com/forum/viewtopic.php?id=6392
				//	user.ip = user.ip.replace('::ffff:', '');
                //
				//	request('http://api.stopforumspam.org/api?ip=' + user.ip + '&email=' + user.email + '&username=' + user.username + '&f=json', function (err, response, body) {
				//		if (err) {
				//			return next(null, user);
				//		}
				//		if (response.statusCode === 200) {
				//			var data = JSON.parse(body);
				//			user.spamData = data;
                //
				//			user.usernameSpam = data.username.frequency > 0 || data.username.appears > 0;
				//			user.emailSpam = data.email.frequency > 0 || data.email.appears > 0;
				//			user.ipSpam = data.ip.frequency > 0 || data.ip.appears > 0;
				//		}
				//		next(null, user);
				//	});
				//}, next);
				next(null, users);
			}
		], callback);
	};

	User.confirmUserRegEmail = function (confirm_code, from, callback) {
		// 通过confirm_code查找waiting列表中的数据，将waiting列表的数据转到注册列表中
		// 并从waiting列表删除
		var uid;
		var wuid;
		var wUserData;
		async.waterfall([
			function(next) {
				winston.verbose('get waiting uid by confirm_code');
				db.sortedSetScore('confirm_code:uid', confirm_code, next);
			},
			function(_wuid, next) {
				winston.verbose('get waiting userdata by wuid = ' + _wuid);
				wuid = _wuid;
				if (!wuid) {
					return next(new Error('The code is not exist.'));
				}
				db.getObject('waitingconfirm:user:' + _wuid, next)
			},
			function(_wUserData, next) {
				winston.verbose('create user by waiting userdata');
				wUserData = _wUserData;
				if (!_wUserData) {
					return callback(new Error('The user is not exist.'));
				}
				User.create(wUserData, next);
			},
			function(_uid, next) {
				winston.verbose('set user hash password');
				uid = _uid;
				User.setUserField(uid, 'password', wUserData.hashedPassword, next);
			},
			function(next) {
				winston.verbose('set user email confirmed 1');
				User.setUserField(uid, 'email:confirmed', 1, next);
			},
			function(next) {
				winston.verbose('sendWelcomeNotification');
				User.notifications.sendWelcomeNotification(uid, next);
			},
			function(next) {
				winston.verbose('removeFromWaitConfirmQueue by confirm_code');
				removeFromWaitConfirmQueue(confirm_code, wuid, next);
			},
			function(next) {
				winston.verbose('markNotificationRead');
				markNotificationRead(wUserData.username, next);
			},
			function(next) {
				winston.verbose('if from !=null send email. or back');
				if (from) {
					// 发邮件，告知通过回复邮件激活的用户--激活成功
					notifySucByEmailReply(wUserData.username, wUserData.email, next);
				} else {
					next();
				}
			}
		], callback);

	};

	function notifySucByEmailReply(username, email, next) {
		var title = meta.config.title || meta.config.browserTitle || '信托麦客';

		var data = {
			site_title: title,
			username: username,
			subject: '信托麦客账号激活成功',
			template: 'regsuc_for_reply'
		};
		emailer.sendToEmail('regsuc_for_reply', email, 'zh_CN', data, next);
	}

	function getConfirmCode() {
		return 'fxtm' + md5(uuid.v4()) + 'fxtm';
	}

	function md5(data) {
		var Buffer = require("buffer").Buffer;
		var buf = new Buffer(data);
		var str = buf.toString("binary");
		var crypto = require("crypto");
		return crypto.createHash("md5").update(str).digest("hex");
	}
};
