
'use strict';

var async = require('async'),
	validator = require('validator'),
	url = require('url'),
	S = require('string'),

	utils = require('../../public/src/utils'),
	meta = require('../meta'),
	events = require('../events'),
	db = require('../database'),
	Password = require('../password'),
	plugins = require('../plugins');

module.exports = function(User) {

	User.updateProfile = function(uid, data, callback) {
		var fields = ['username', 'email', 'fullname', 'website', 'location', 'birthday', 'signature', 'aboutme',
			'bq_registration_realname',
			'bq_registration_company',
			//'bq_registration_company_email',
			'bq_registration_mobile',
			'bq_registration_wechat',
			'bq_registration_address'
		];

		plugins.fireHook('filter:user.updateProfile', {uid: uid, data: data, fields: fields}, function(err, data) {
			if (err) {
				return callback(err);
			}

			fields = data.fields;
			data = data.data;

			function isAboutMeValid(next) {
				if (data.aboutme !== undefined && data.aboutme.length > meta.config.maximumAboutMeLength) {
					next(new Error('[[error:about-me-too-long, ' + meta.config.maximumAboutMeLength + ']]'));
				} else {
					next();
				}
			}

			function isSignatureValid(next) {
				if (data.signature !== undefined && data.signature.length > meta.config.maximumSignatureLength) {
					next(new Error('[[error:signature-too-long, ' + meta.config.maximumSignatureLength + ']]'));
				} else {
					next();
				}
			}

			function isEmailAvailable(next) {
				if (!data.email) {
					return next(new Error('邮件地址不能为空'));
				}

				if (!utils.isEmailValid(data.email)) {
					return next(new Error('[[error:invalid-email]]'));
				}

				User.getUserField(uid, 'email', function(err, email) {
					if(email === data.email) {
						return next();

					}

					User.email.available(data.email, function(err, available) {
						if (err) {
							return next(err);
						}

						next(!available ? new Error('[[error:email-taken]]') : null);
					});
				});
			}

			function isUsernameAvailable(next) {
				if (!data.username) {
					return next(new Error('用户名不能为空'));
				}
				User.getUserFields(uid, ['username', 'userslug'], function(err, userData) {

					var userslug = utils.slugify(data.username);

					if(userslug === userData.userslug) {
						return next();
					}

					if (data.username.length < meta.config.minimumUsernameLength) {
						return next(new Error('[[error:username-too-short]]'));
					}

					if (data.username.length > meta.config.maximumUsernameLength) {
						return next(new Error('[[error:username-too-long]]'));
					}

					if(!utils.isUserNameValid(data.username) || !userslug) {
						return next(new Error('[[error:invalid-username]]'));
					}

					User.exists(userslug, function(err, exists) {
						if(err) {
							return next(err);
						}

						next(exists ? new Error('[[error:username-taken]]') : null);
					});
				});
			}

			function isMobileAvailable(next) {
				if (!data.bq_registration_mobile) {
					return next(new Error('手机号不能为空'));
				}
				if (!validator.isMobilePhone(data.bq_registration_mobile, 'zh-CN')) {
					return next(new Error('手机号无效'));
				} else {
					next();
				}
			}

			function isOtherFieldsNull(next) {
				if (!data.bq_registration_realname) {
					return next(new Error('真实姓名不能为空'));
				}
				if (!data.bq_registration_company) {
					return next(new Error('公司名称不能为空'));
				}
				if (!data.bq_registration_wechat) {
					return next(new Error('微信号不能为空'));
				}
				next();

			}

			async.series([isAboutMeValid, isSignatureValid, isEmailAvailable, isUsernameAvailable, isOtherFieldsNull, isMobileAvailable], function(err) {
				if (err) {
					return callback(err);
				}

				async.each(fields, updateField, function(err) {
					if (err) {
						return callback(err);
					}
					plugins.fireHook('action:user.updateProfile', {data: data, uid: uid});
					User.getUserFields(uid, ['email', 'modify_email', 'username', 'userslug', 'picture', 'gravatarpicture'], callback);
				});
			});

			function updateField(field, next) {
				if (!(data[field] !== undefined && typeof data[field] === 'string')) {
					return next();
				}

				data[field] = data[field].trim();

				if (field === 'email') {
					return updateEmail(uid, data.email, next);
				} else if (field === 'username') {
					return updateUsername(uid, data.username, next);
				} else if (field === 'fullname') {
					return updateFullname(uid, data.fullname, next);
				} else if (field === 'signature') {
					data[field] = S(data[field]).stripTags().s;
				}

				User.setUserField(uid, field, data[field], next);
			}
		});
	};

	function updateEmail(uid, newEmail, callback) {
		User.getUserFields(uid, ['email', 'modify_email', 'picture', 'uploadedpicture'], function(err, userData) {
			if (err) {
				return callback(err);
			}

			userData.email = userData.email || '';

			if (userData.email === newEmail) {
				return callback();

			} else if (userData.modify_email === newEmail) { // 如果与前一次未确认的邮箱相同，不处理
				return callback();
			}

			async.series([
				async.apply(db.sortedSetRemove, 'email:uid', userData.email.toLowerCase()),
				async.apply(db.sortedSetRemove, 'email:sorted', userData.email.toLowerCase() + ':' + uid)
			], function(err) {
				if (err) {
					return callback(err);
				}

				//var gravatarpicture = User.createGravatarURLFromEmail(newEmail);
				var gravatarpicture = '';

					async.parallel([
					function(next) {
						User.setUserField(uid, 'gravatarpicture', gravatarpicture, next);
					},
					function(next) {
						db.sortedSetAdd('email:uid', uid, newEmail.toLowerCase(), next);
					},
					function(next) {
						db.sortedSetAdd('email:sorted',  0, newEmail.toLowerCase() + ':' + uid, next);
					},
					function(next) {

						//改为先保存到modify_emalil中
						User.setUserField(uid, 'modify_email', newEmail, next);
					},
					function(next) { // 清零，防止连续有效的改动，但因为之前已发送过邮件而导致不能发送的问题
						db.set('uid:' + uid + ':confirm:email:sent', 0, next);
					},
					function(next) {
						// 只要新邮件不为空，就发送验证邮件  parseInt(meta.config.requireEmailConfirmation, 10) === 1 &&
						if (newEmail) {
							User.email.sendValidationEmail(uid, newEmail);
						}
						User.setUserField(uid, 'email:confirmed', 0, next);
					},
					function(next) {
						if (userData.picture !== userData.uploadedpicture) {
							User.setUserField(uid, 'picture', gravatarpicture, next);
						} else {
							next();
						}
					},
				], callback);
			});
		});
	}

	function updateUsername(uid, newUsername, callback) {
		if (!newUsername) {
			return callback();
		}

		User.getUserFields(uid, ['username', 'userslug'], function(err, userData) {
			if (err) {
				return callback(err);
			}

			async.parallel([
				function(next) {
					updateUidMapping('username', uid, newUsername, userData.username, next);
				},
				function(next) {
					var newUserslug = utils.slugify(newUsername);
					updateUidMapping('userslug', uid, newUserslug, userData.userslug, next);
				},
				function(next) {
					async.series([
						async.apply(db.sortedSetRemove, 'username:sorted', userData.username.toLowerCase() + ':' + uid),
						async.apply(db.sortedSetAdd, 'username:sorted', 0, newUsername.toLowerCase() + ':' + uid)
					], next);
				},
			], callback);
		});
	}

	function updateUidMapping(field, uid, value, oldValue, callback) {
		if (value === oldValue) {
			return callback();
		}

		async.series([
			function(next) {
				db.sortedSetRemove(field + ':uid', oldValue, next);
			},
			function(next) {
				User.setUserField(uid, field, value, next);
			},
			function(next) {
				if (value) {
					db.sortedSetAdd(field + ':uid', uid, value, next);
				} else {
					next();
				}
			}
		], callback);
	}

	function updateFullname(uid, newFullname, callback) {
		async.waterfall([
			function(next) {
				User.getUserField(uid, 'fullname', next);
			},
			function(fullname, next) {
				updateUidMapping('fullname', uid, newFullname, fullname, next);
			}
		], callback);
	}

	User.changePassword = function(uid, data, callback) {
		if (!uid || !data || !data.uid) {
			return callback(new Error('[[error:invalid-uid]]'));
		}

		function hashAndSetPassword(callback) {
			User.hashPassword(data.newPassword, function(err, hash) {
				if (err) {
					return callback(err);
				}

				async.parallel([
					async.apply(User.setUserField, data.uid, 'password', hash),
					async.apply(User.reset.updateExpiry, data.uid)
				], callback);
			});
		}

		if (!utils.isPasswordValid(data.newPassword)) {
			return callback(new Error('[[user:change_password_error]]'));
		}

		if(parseInt(uid, 10) !== parseInt(data.uid, 10)) {
			User.isAdministrator(uid, function(err, isAdmin) {
				if(err || !isAdmin) {
					return callback(err || new Error('[[user:change_password_error_privileges'));
				}

				hashAndSetPassword(callback);
			});
		} else {
			db.getObjectField('user:' + uid, 'password', function(err, currentPassword) {
				if(err) {
					return callback(err);
				}

				if (!currentPassword) {
					return hashAndSetPassword(callback);
				}

				Password.compare(data.currentPassword, currentPassword, function(err, res) {
					if (err || !res) {
						return callback(err || new Error('[[user:change_password_error_wrong_current]]'));
					}
					hashAndSetPassword(callback);
				});
			});
		}
	};
};
