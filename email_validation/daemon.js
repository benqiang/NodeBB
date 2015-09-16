/**
 * Created by jacky on 15/9/17.
 */
var cproc = require('child_process');

function spawn(mainModule) {
	var worker = cproc.spawn('node', [ mainModule ]);

	worker.on('exit', function (code) {
		if (code !== 0) {
			console.log('error. restart emailservice');
			spawn(mainModule);
		}
	});

	worker.stdout.on('data', function (data) {
		console.log('stdout: ' + data);
	});

	//监听子进程的错误流数据
	worker.stderr.on('data', function (data) {
		console.log('stderr: ' + data);
	});

	//监听子进程的退出事件
	worker.on('close', function (code) {
		console.log('子进程退出，code：' + code);
	});
}
console.log('start emailservice');
spawn('./emailservice.js');