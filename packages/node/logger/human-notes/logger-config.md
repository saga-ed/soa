I would like the logger to have the following behaviors

NODE_ENV=local

always instantiate a console logger
if logFile is specified in the configuration instantiate a console logger and a file logger

NODE_ENV=development

if the logger is running in an express context and it is running in the foreground then instantiate a console logger
if the logger configuration specified also instantiate a file logger

NODE_ENV=production

if the logger is running in an express context require logFile is non-null and always instantiate a file logger
if the express API is running in the foreground also instantiate a console logger
