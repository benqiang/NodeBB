'use strict';

var async = require('async'),
	db = require('../database'),
	utils = require('../../public/src/utils'),
	validator = require('validator'),
	plugins = require('../plugins'),
	groups = require('../groups'),
	meta = require('../meta'),
	notifications = require('../notifications'),
	translator = require('../../public/src/modules/translator');

module.exports = function(User) {

	User.create = function(data, callback) {

		data.username = data.username.trim();
		data.userslug = utils.slugify(data.username);
		if (data.email !== undefined) {
			data.email = validator.escape(data.email.trim());
		}

		User.isDataValid(data, function(err) {
			if (err)  {
				return callback(err);
			}

			// 注释掉gravatar的使用
			//var gravatar = User.createGravatarURLFromEmail(data.email);
			var timestamp = data.timestamp || Date.now();

			var userData = {
				'username': data.username,
				'userslug': data.userslug,
				'email': data.email,
				// 记录最初注册的邮箱
				'register_email': data.email,
				'joindate': timestamp,
				// 注释掉这两项
				//'picture': gravatar,
				//'gravatarpicture': gravatar,
				'fullname': '',
				'location': '',
				'birthday': '',
				'website': '',
				'signature': '',
				// 把picture再加上，并将下面这两项改为默认的图片
				'picture': '/uploads/profile/0-profileimg.jpg',
				'uploadedpicture': '/uploads/profile/0-profileimg.jpg',
				'profileviews': 0,
				'reputation': 0,
				'postcount': 0,
				'topiccount': 0,
				'lastposttime': 0,
				'banned': 0,
				'status': 'online'
			};

			if (data.bq_registration_realname) {
				userData['bq_registration_realname'] = data.bq_registration_realname;
			}
			if (data.bq_registration_company) {
				userData['bq_registration_company'] = data.bq_registration_company;
			}
			//if (data.bq_registration_company_email) {
			//	userData['bq_registration_company_email'] = data.bq_registration_company_email;
			//}
			if (data.bq_registration_mobile) {
				userData['bq_registration_mobile'] = data.bq_registration_mobile;
			}
			if (data.bq_registration_wechat) {
				userData['bq_registration_wechat'] = data.bq_registration_wechat;
			}
			if (data.bq_registration_namecard) {
				userData['bq_registration_namecard'] = data.bq_registration_namecard;
			}
			if (data.bq_reg_has_authenticated) {
				userData['bq_reg_has_authenticated'] = data.bq_reg_has_authenticated;
			}

			async.parallel({
				renamedUsername: function(next) {
					renameUsername(userData, next);
				},
				userData: function(next) {
					plugins.fireHook('filter:user.create', {user: userData, data: data}, next);
				}
			}, function(err, results) {
				if (err) {
					return callback(err);
				}

				var userNameChanged = !!results.renamedUsername;

				if (userNameChanged) {
					userData.username = results.renamedUsername;
					userData.userslug = utils.slugify(results.renamedUsername);
				}

				async.waterfall([
					function(next) {
						db.incrObjectField('global', 'nextUid', next);
					},
					function(uid, next) {
						userData.uid = uid;
						db.setObject('user:' + uid, userData, next);
					},
					function(next) {
						async.parallel([
							function(next) {
								db.incrObjectField('global', 'userCount', next);
							},
							function(next) {
								db.sortedSetAdd('username:uid', userData.uid, userData.username, next);
							},
							function(next) {
								db.sortedSetAdd('username:sorted', 0, userData.username.toLowerCase() + ':' + userData.uid, next);
							},
							function(next) {
								db.sortedSetAdd('userslug:uid', userData.uid, userData.userslug, next);
							},
							function(next) {
								db.sortedSetAdd('users:joindate', timestamp, userData.uid, next);
							},
							function(next) {
								db.sortedSetsAdd(['users:postcount', 'users:reputation'], 0, userData.uid, next);
							},
							function(next) {
								groups.join('registered-users', userData.uid, next);
							},
							function(next) {
								if (userData.email) {
									async.parallel([
										async.apply(db.sortedSetAdd, 'email:uid', userData.uid, userData.email.toLowerCase()),
										async.apply(db.sortedSetAdd, 'email:sorted', 0, userData.email.toLowerCase() + ':' + userData.uid)
									], next);

									if (parseInt(userData.uid, 10) !== 1 && parseInt(meta.config.requireEmailConfirmation, 10) === 1) {
										User.email.sendValidationEmail(userData.uid, userData.email);
									}
								} else {
									next();
								}
							},
							function(next) {
								if (!data.password) {
									return next();
								}

								User.hashPassword(data.password, function(err, hash) {
									if (err) {
										return next(err);
									}

									async.parallel([
										async.apply(User.setUserField, userData.uid, 'password', hash),
										async.apply(User.reset.updateExpiry, userData.uid)
									], next);
								});
							}
						], next);
					},
					function(results, next) {
						if (userNameChanged) {
							User.notifications.sendNameChangeNotification(userData.uid, userData.username);
						}
						plugins.fireHook('action:user.create', userData);
						next(null, userData.uid);
					}
				], callback);
			});
		});
	};

	User.isDataValid = function(userData, callback) {
		async.parallel({
			emailValid: function(next) {
				if (userData.email) {
					next(!utils.isEmailValid(userData.email) ? new Error('[[error:invalid-email]]') : null);
				} else {
					next();
				}
			},
			userNameValid: function(next) {
				next((!utils.isUserNameValid(userData.username) || !userData.userslug) ? new Error('[[error:invalid-username]]') : null);
			},
			passwordValid: function(next) {
				if (userData.password) {
					next(!utils.isPasswordValid(userData.password) ? new Error('[[error:invalid-password]]') : null);
				} else {
					next();
				}
			},
			emailAvailable: function(next) {
				if (userData.email) {
					User.email.available(userData.email, function(err, available) {
						if (err) {
							return next(err);
						}
						next(!available ? new Error('[[error:email-taken]]') : null);
					});
				} else {
					next();
				}
			}
		}, function(err, results) {
			callback(err);
		});
	};

	function renameUsername(userData, callback) {
		meta.userOrGroupExists(userData.userslug, function(err, exists) {
			if (err || !exists) {
				return callback(err);
			}

			var	newUsername = '';
			async.forever(function(next) {
				newUsername = userData.username + (Math.floor(Math.random() * 255) + 1);
				User.exists(newUsername, function(err, exists) {
					if (err) {
						return callback(err);
					}
					if (!exists) {
						next(newUsername);
					} else {
						next();
					}
				});
			}, function(username) {
				callback(null, username);
			});
		});
	};

	User.createWaitingConfirmUser = function(data, callback) {
		var userData = {
			'username': data.username,
			'email': data.email,
			'hashedPassword': data.hashedPassword,
			'bq_registration_realname': data.bq_registration_realname,
			'bq_registration_company': data.bq_registration_company,
			'bq_registration_mobile': data.bq_registration_mobile,
			'bq_registration_wechat': data.bq_registration_wechat,
			'bq_registration_namecard': data.bq_registration_namecard,
			'bq_reg_has_authenticated': data.bq_reg_has_authenticated,
			'confirm_code': data.confirm_code
		};
		async.waterfall([
			function(next) {
				db.incrObjectField('global', 'nextWaitingConfirmUid', next);
			},
			function(uid, next) {
				userData.uid = uid;
				db.setObject('waitingconfirm:user:' + uid, userData, next);

			},
			function(next) {
				db.sortedSetAdd('confirm_code:uid', userData.uid, userData.confirm_code, next);
			}
			], function(err, result) {
				if (!err) {
					callback(null, userData.uid);
				}
			});

	};

};
