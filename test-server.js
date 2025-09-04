const http = require('http');

const server = http.createServer((req, res) => {
  console.log(`Received request for ${req.url}`);
  
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  
  if (req.url === '/mcp' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      console.log('Received body:', body);
      try {
        const jsonBody = JSON.parse(body);
        
        if (jsonBody.method === 'tools/call' && 
            jsonBody.params?.name === 'search' && 
            jsonBody.params?.arguments?.query) {
          
          // Always return 20 mock results
          const results = [];
          const query = jsonBody.params.arguments.query;
          
          for (let i = 0; i < 20; i++) {
            results.push({
              id: `page-${i + 1}`,
              title: `Result ${i + 1} for "${query}"`,
              url: `https://example.atlassian.net/wiki/spaces/TEST/pages/${i + 1}`,
              excerpt: `This is an example result ${i + 1} for the search query "${query}". It contains relevant information.`
            });
          }
          
          const response = {
            jsonrpc: '2.0',
            id: jsonBody.id,
            result: {
              cql: `type=page and text ~ ${query}`,
              results,
              pagination: {
                start: 0,
                limit: 50,
                size: results.length,
                totalSize: 100
              }
            }
          };
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          return;
        }
        
        // Default response for other methods
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: jsonBody.id,
          result: { ok: true }
        }));
      } catch (error) {
        console.error('Error processing request:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    
    return;
  }
  
  // Default response for other URLs
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const port = 5000;
server.listen(port, '127.0.0.1', () => {
  console.log(`Test server listening at http://localhost:${port}/`);
});
