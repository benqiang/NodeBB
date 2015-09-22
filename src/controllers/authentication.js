"use strict";

var async = require('async'),
	winston = require('winston'),
	passport = require('passport'),
	nconf = require('nconf'),
	validator = require('validator'),

	path = require('path'),
	fs = require('fs'),

	file = require('../file'),

	db = require('../database'),
	meta = require('../meta'),
	user = require('../user'),
	plugins = require('../plugins'),
	utils = require('../../public/src/utils'),
	Password = require('../password'),

	authenticationController = {};

authenticationController.register = function(req, res, next) {
	var registrationType = meta.config.registrationType || 'normal';

	if (registrationType === 'disabled') {
		return res.sendStatus(403);
	}

	var userData = {};

	for (var key in req.body) {
		if (req.body.hasOwnProperty(key)) {
			userData[key] = req.body[key];
		}
	}

	winston.verbose('Register body = ' + JSON.stringify(req.body));
	winston.verbose('Register body file = ' + JSON.stringify(req.files.file_namecard));

	var uid;

	// 得到图片文件对象
	var uploadedFile = req.files.file_namecard;
	var tmpNamecardUrl = '';

	async.waterfall([
		function(next) {
			if (registrationType === 'invite-only') {
				user.verifyInvitation(userData, next);
			} else {
				next();
			}
		},
		function(next) {
			if (!userData.email) {
				return next(new Error('[[error:invalid-email]]'));
			}

			if (!userData.username || userData.username.length < meta.config.minimumUsernameLength) {
				return next(new Error('[[error:username-too-short]]'));
			}

			if (userData.username.length > meta.config.maximumUsernameLength) {
				return next(new Error('[[error:username-too-long'));
			}

			if (!userData.password || userData.password.length < meta.config.minimumPasswordLength) {
				return next(new Error('[[user:change_password_error_length]]'));
			}

			next();
		},
		function(next) {
			plugins.fireHook('filter:register.check', {req: req, res: res, userData: userData}, next);
		},
		function (data, next) {
			// 检查是否有图
			if (!uploadedFile) {
				return next(new Error('请上传名片'));
			}
			// 对图片类型进行检查，如果需要，在此加入图片大小的检查
			winston.verbose('register - uploadedFile validate');
			var err = validateUpload(uploadedFile);
			if (err) {
				return next(err);
			}
			winston.verbose('register - uploadedFile validate done');

			next(null, data);
		},
		function(data, next) {
			// 图片保存到本地
			upload(uploadedFile, function (err, imgurl) {
				if (err) {
					next(err);
				} else {
					tmpNamecardUrl = imgurl;
					next(null, data);
				}
			});

		},
		function(data, next) {
			if (registrationType === 'normal' || registrationType === 'invite-only') {
				registerAndLoginUser(req, res, userData, next);
			} else if (registrationType === 'admin-approval') {
				addToApprovalQueue(req, res, userData, next);
			}
		},
		function(data, next) {

			winston.verbose('mid-reg data=' + JSON.stringify(data));
			if (registrationType === 'normal' || registrationType === 'invite-only') {
				// 执行完前面的步骤（图片检查通过、保存到本地通过、注册用户信息通过），在此将图片的路径也保存到数据库中。
				// 这样就完成了，图片的上传及保存
				db.setObjectField('user:' + data.uid, 'namecard', tmpNamecardUrl, function(err) {
					if (err) {
						winston.verbose('mid-reg-save to db failed, err = ' + err.message);
						next(err);
					} else {
						winston.verbose('mid-reg-save to db suc, data = ' + JSON.stringify(data));
						next(null, data);
					}
				});
			}  else if (registrationType === 'admin-approval') {
				 db.setObject('registration:queue:name:' + userData.username, {bq_registration_namecard: tmpNamecardUrl}, function(err) {
					 if (err) {
						next(err);
					 } else {
						 next(null, data);
					 }
				 });
			}


		}
	], function(err, data) {
		if (err) {
			winston.verbose('register complete. err = ' + err.message);
			return res.status(400).send(err.message);
		}

		// 将模板数据修改一下即可
		if (registrationType !== 'admin-approval' && req.body.nextTo) {
			data.referrer = req.body.nextTo;

		}

		if (req.body.nextTo) {
			data.from = 1;
		} else {
			data.from = 0;
		}

		winston.verbose('done-reg data=' + JSON.stringify(data));
		res.json(data);
	});
};

function registerAndLoginUser(req, res, userData, callback) {
	var uid;
	async.waterfall([
		function(next) {
			user.create(userData, next);
		},
		function(_uid, next) {
			uid = _uid;
			req.login({uid: uid}, next);
		},
		function(next) {
			user.logIP(uid, req.ip);

			user.deleteInvitation(userData.email);

			user.notifications.sendWelcomeNotification(uid);

			plugins.fireHook('filter:register.complete', {uid: uid, referrer: req.body.referrer || nconf.get('relative_path') + '/'}, next);
		}
	], callback);
}

function addToApprovalQueue(req, res, userData, callback) {
	async.waterfall([
		function(next) {
			userData.ip = req.ip;
			user.addToApprovalQueue(userData, next);
		},
		function(next) {
			next(null, {message: '[[register:registration-added-to-queue]]'});
		}
	], callback);
}

authenticationController.login = function(req, res, next) {
	// Handle returnTo data
	if (req.body.hasOwnProperty('returnTo') && !req.session.returnTo) {
		req.session.returnTo = req.body.returnTo;
	}

	if (plugins.hasListeners('action:auth.overrideLogin')) {
		return continueLogin(req, res, next);
	}

	var loginWith = meta.config.allowLoginWith || 'username-email';

	if (req.body.username && utils.isEmailValid(req.body.username) && loginWith.indexOf('email') !== -1) {
		user.getUsernameByEmail(req.body.username, function(err, username) {
			if (err) {
				return next(err);
			}
			req.body.username = username ? username : req.body.username;
			continueLogin(req, res, next);
		});
	} else if (loginWith.indexOf('username') !== -1 && !validator.isEmail(req.body.username)) {
		continueLogin(req, res, next);
	} else {
		res.status(500).send('[[error:wrong-login-type-' + loginWith + ']]');
	}
};

function continueLogin(req, res, next) {
	passport.authenticate('local', function(err, userData, info) {
		if (err) {
			return res.status(403).send(err.message);
		}

		if (!userData) {
			if (typeof info === 'object') {
				info = '[[error:invalid-username-or-password]]';
			}

			return res.status(403).send(info);
		}

		var passwordExpiry = userData.passwordExpiry !== undefined ? parseInt(userData.passwordExpiry, 10) : null;

		// Alter user cookie depending on passed-in option
		if (req.body.remember === 'on') {
			var duration = 1000*60*60*24*parseInt(meta.config.loginDays || 14, 10);
			req.session.cookie.maxAge = duration;
			req.session.cookie.expires = new Date(Date.now() + duration);
		} else {
			req.session.cookie.maxAge = false;
			req.session.cookie.expires = false;
		}

		if (passwordExpiry && passwordExpiry < Date.now()) {
			winston.verbose('[auth] Triggering password reset for uid ' + userData.uid + ' due to password policy');
			req.session.passwordExpired = true;
			user.reset.generate(userData.uid, function(err, code) {
				res.status(200).send(nconf.get('relative_path') + '/reset/' + code);
			});
		} else {
			req.login({
				uid: userData.uid
			}, function(err) {
				if (err) {
					return res.status(403).send(err.message);
				}
				if (userData.uid) {
					user.logIP(userData.uid, req.ip);

					plugins.fireHook('action:user.loggedIn', userData.uid);
				}

				// 这里就是要改的地方，添加对是否存在nextTo参数的判断，如果有，就返回
				if (req.body.nextTo) {
					res.status(200).send(req.body.nextTo);

				} else if (!req.session.returnTo) {
					res.status(200).send(nconf.get('relative_path') + '/');
				} else {
					var next = req.session.returnTo;
					delete req.session.returnTo;

					res.status(200).send(next);
				}
			});
		}
	})(req, res, next);
}

authenticationController.localLogin = function(req, username, password, next) {
	if (!username || !password) {
		return next(new Error('[[error:invalid-password]]'));
	}

	var userslug = utils.slugify(username);
	var uid, userData = {};

	async.waterfall([
		function(next) {
			user.getUidByUserslug(userslug, next);
		},
		function(_uid, next) {
			if (!_uid) {
				return next(new Error('[[error:no-user]]'));
			}
			uid = _uid;
			user.auth.logAttempt(uid, req.ip, next);
		},
		function(next) {
			async.parallel({
				userData: function(next) {
					db.getObjectFields('user:' + uid, ['password', 'banned', 'passwordExpiry'], next);
				},
				isAdmin: function(next) {
					user.isAdministrator(uid, next);
				}
			}, next);
		},
		function(result, next) {
			userData = result.userData;
			userData.uid = uid;
			userData.isAdmin = result.isAdmin;

			if (!result.isAdmin && parseInt(meta.config.allowLocalLogin, 10) === 0) {
				return next(new Error('[[error:local-login-disabled]]'));
			}

			if (!userData || !userData.password) {
				return next(new Error('[[error:invalid-user-data]]'));
			}
			if (userData.banned && parseInt(userData.banned, 10) === 1) {
				return next(new Error('[[error:user-banned]]'));
			}
			Password.compare(password, userData.password, next);
		},
		function(passwordMatch, next) {
			if (!passwordMatch) {
				return next(new Error('[[error:invalid-password]]'));
			}
			user.auth.clearLoginAttempts(uid);
			next(null, userData, '[[success:authentication-successful]]');
		}
	], next);
};

authenticationController.logout = function(req, res, next) {
	if (req.user && parseInt(req.user.uid, 10) > 0 && req.sessionID) {
		var uid = parseInt(req.user.uid, 10);
		require('../socket.io').logoutUser(req.user.uid);
		db.sessionStore.destroy(req.sessionID, function(err) {
			if (err) {
				return next(err);
			}
			req.logout();

			plugins.fireHook('action:user.loggedOut', {req: req, res: res, uid: uid});
			res.writeHead(
				200,
				{'Access-Control-Allow-Origin':'http://xintuomarket.com'}
			);
			res.end('');
			//res.status(200).send('');
		});
	} else {
		res.writeHead(
			200,
			{'Access-Control-Allow-Origin':'http://xintuomarket.com'}
		);
		res.end('');
		//res.status(200).send('');
	}
};

function upload(uploadedFile, callback) {
	var md5Str = md5(uploadedFile.name + uploadedFile.type + uploadedFile.size);
	var filename = md5Str + path.extname(uploadedFile.name);
	uploadImage(filename, 'namecard', uploadedFile, callback);

}

function validateUpload(uploadedFile) {
	var err = null;
	var allowedTypes = ['image/png', 'image/jpeg', 'image/pjpeg', 'image/jpg', 'image/gif'];
	if (allowedTypes.indexOf(uploadedFile.type) === -1) {
		fs.unlink(uploadedFile.path);
		err = new Error('图片格式只能是png、jpeg/jpg、gif');
	}
	return err;
}

function uploadImage(filename, folder, uploadedFile, callback) {
	function done(err, image) {
		fs.unlink(uploadedFile.path);
		if (err) {
			return callback(err);
		}
		return callback(null, nconf.get('relative_path') + image.url);
	}
	file.saveFileToLocal(filename, folder, uploadedFile.path, done);
}

function md5(data) {
	var Buffer = require("buffer").Buffer;
	var buf = new Buffer(data);
	var str = buf.toString("binary");
	var crypto = require("crypto");
	return crypto.createHash("md5").update(str).digest("hex");
}

module.exports = authenticationController;
