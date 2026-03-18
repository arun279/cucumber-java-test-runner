const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request: string, parent: any, ...args: any[]) {
  if (request === 'vscode') {
    return require.resolve('./mocks/vscode');
  }
  return originalResolveFilename.call(this, request, parent, ...args);
};
