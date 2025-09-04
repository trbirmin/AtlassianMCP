// simple-server.js
const http = require('http');

const server = http.createServer((req, res) => {
  console.log(`Received request for ${req.url}`);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello, this is a simple test server!');
});

const port = 3002;
server.listen(port, 'localhost', () => {
  console.log(`Server running at http://localhost:${port}/`);
});
