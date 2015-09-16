var Imap = require('imap');
var inspect = require('util').inspect;
var Mailparser = require('mailparser').MailParser;
var fs = require('fs');
var http = require("http");
var url = require("url");
var schedule = require("node-schedule");


function checkoutEmail() {
	var imap = new Imap({
		user: 'zhangbenqiang@yimian.com.cn',
		password: 'ivy123456',
		host: 'imap.exmail.qq.com',
		port: 993,
		tls: true
		//debug: function(info) { console.log(info); }
	});

	function openIndex(cb) {
		imap.openBox('INBOX', false, cb) ;
	}

	imap.once('ready', function() {
		openIndex(function(err, box){
			//邮件搜索: 2015/7/28以后未读的
			imap.search(['UNSEEN', ['SINCE', 'July 28, 2015']], function(err, results){
				console.log(results);
				if(err) console.log( err );

				var f = imap.fetch(results, {

					bodies: '',
					struct: true,
					markSeen:true
				});

				f.on('message', function(msg, seqno){
					console.log('Message #%d', seqno);
					var prefix = '(#' + seqno + ')' ;
					msg.on('body', function(stream, info){
						console.log('INFO WHICH: ',info.which);
						if(info.which === 'TEXT') {
							console.log(prefix + 'Body [%s] found, %d total bytes',inspect(info.which), info.size) ;
						}

						var mailparser = new Mailparser();
						stream.pipe(mailparser);
						mailparser.on('end',function(mail){

							//将mail的内容保存到根目录下的一个html文件里
							//fs.writeFile('msg-'+seqno+'-body.html',mail.html,function(err){
							//	if(err) throw err;
							//	console.log(prefix + 'saved!');
							//});
							var content = mail.html;
							var reg = /fxtm\w{2,}fxtm/g;

							var reg2 = /extm\w{2,}extm/g;

							var result = content.match(reg);
							if (result) {
								console.log('[XTM] code=' + result[0]);

								var tmpUrl = 'http://localhost:4567/user/confirm?from=emailreply&code=' + result[0];

								http.get(tmpUrl, function(res){
									res.setEncoding("utf-8");

									var resData = [];

									res.on("data", function(chunk){
										resData.push(chunk);
									}).on("end", function(){
										console.log(resData.join(""));
									});
								});

								imap.seq.setFlags([seqno], ['Seen'], function(err) {
									if(err) {
										console.log('测试 err=' + err.message);
									} else {
										console.log('测试 no error');
									}
								});

							} else {
								result = content.match(reg2);
								if (result) {
									console.log('[XTM] code=' + result[0]);
									var tmpUrl = 'http://localhost:4567/confirm/'+ result[0] + '?from=emailreply';
									http.get(tmpUrl, function(res){
										res.setEncoding("utf-8");

										var resData = [];

										res.on("data", function(chunk){
											resData.push(chunk);
										}).on("end", function(){
											console.log(resData.join(""));
										});
									});
								}
							}

						});
					});

					msg.once('attributes', function(attrs){
						console.log(prefix + 'Attributes: %s',inspect(attrs,false,8));
					});

					msg.once('end', function(){
						console.log(prefix + 'Finished');
					});
				});

				f.once('error', function(err){
					console.log('Fetch error: '+err);
				});

				f.once('end', function(){
					console.log('Done fetching all messages!');
					imap.end();
				});
			});
		});
	});

	imap.once('error', function(err){
		console.log(err)
	});

	imap.once('end', function(){
		console.log('Connection ended');
	});

	imap.connect();
}


var rule = new schedule.RecurrenceRule();

rule.second = new schedule.Range(0, 59, 20);

schedule.scheduleJob(rule, function(){
	console.log(rule);
	console.log('handle email---------------------------');
	checkoutEmail();
});

