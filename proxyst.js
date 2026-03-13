const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const PROXY_NAME = "El Rio";
// Load config with reloading capability
let config = loadConfig();
let PORT = config['service-port'] || 3000;

// Watch config for changes
fs.watchFile('config.json', (curr, prev) => {
    if (curr.mtime !== prev.mtime) {
        console.log('📁 Config file changed, reloading...');
        try {
            config = loadConfig();
            console.log('✅ Config reloaded successfully');
            // Update port if changed
            const newPort = config['service-port'] || 3000;
            if (newPort !== PORT) {
                console.log(`⚠️  Port changed to ${newPort}. Restart server to apply.`);
            }
        } catch (error) {
            console.error('❌ Failed to reload config:', error.message);
        }
    }
});

function loadConfig() {
    const configFile = fs.readFileSync('config.json', 'utf8');
    const config = JSON.parse(configFile);
    return config;
}

// Helper: Choose http or https module
function getHttpModule(url) {
    return url.protocol === 'https:' ? https : http;
}

async function forwardRequest(req, res, targetUrl) {  // ← CHANGED: Added res parameter
    return new Promise((resolve, reject) => {
        const url = new URL(targetUrl);
        const httpModule = getHttpModule(url);
        
        // Prepare headers (remove host, add x-forwarded headers)
        const headers = { ...req.headers };
        delete headers.host;
        
        headers['x-forwarded-for'] = req.socket.remoteAddress;
        headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
        headers['x-forwarded-host'] = req.headers.host;
        
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: req.method,
            headers: headers,
            timeout: 300000  // ← CHANGED: 5 minutes for large files
        };
        
        const proxyReq = httpModule.request(options, (proxyRes) => {
            // ✅ LINE 1: Send headers to browser immediately
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            
            // ✅ LINE 2: STREAM directly to browser - THIS IS THE MAGIC!
            proxyRes.pipe(res);  // ← Each chunk goes to browser as it arrives
            
            // ✅ LINE 3: When done, resolve
            proxyRes.on('end', () => {
                resolve();  // No data needed, already streamed
            });
        });
        
        proxyReq.on('error', (err) => {
            // If error, make sure to end the response
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
            }
            reject(err);
        });
        
        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) {
                res.writeHead(504);
                res.end('Gateway Timeout');
            }
            reject(new Error('Request timeout'));
        });
        
        // ✅ THIS PART STAYS THE SAME - IT'S ALREADY GOOD!
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            req.pipe(proxyReq);  // ← Already streams request body
        } else {
            proxyReq.end();
        }
    });
}


// Helper: Forward request
// Find matching route
function findMatchingRoute(requestPath) {
    // Sort by path length (longest first) to ensure most specific match first
    const sortedRoutes = [...config.routes]
        .filter(route => route.enabled)
        .sort((a, b) => b.path.length - a.path.length);
    
    for (const route of sortedRoutes) {
        if (requestPath.startsWith(route.path)) {
            return route;
        }
    }
    return null;
}

// Build target URL
function buildTargetUrl(route, requestUrl) {
    const url = new URL(requestUrl, `http://localhost:${PORT}`);
    const remainingPath = url.pathname.substring(route.path.length);
    
    // Handle edge cases
    let finalPath = remainingPath;
    if (!finalPath.startsWith('/') && finalPath !== '') {
        finalPath = '/' + finalPath;
    }
    
    // Return full target URL
    return `${route.target}${finalPath}${url.search}`;
}

// Create server
const server = http.createServer(async (req, res) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    
    try {
        // Find matching route (using current config)
        const route = findMatchingRoute(req.url.split('?')[0]);
        
        if (!route) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Route not found',
                message: `No route configured for ${req.url}`,
                proxy:PROXY_NAME
            }));
            return;
        }
        
        console.log(`  → Matched: ${route.path} -> ${route.target}`);
        
        // Build target URL
        const targetUrl = buildTargetUrl(route, req.url);
        console.log(`  → Forwarding to: ${targetUrl}`);
        
        // Forward the request
        const response = await forwardRequest(req, targetUrl);
        
        // Send response back to client
        res.writeHead(response.statusCode, response.headers);
        res.end(response.body);
        
        console.log(`  ← Response: ${response.statusCode}`);
        
    } catch (error) {
        console.error(`  ✗ Error: ${error.message}`);
        
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Bad Gateway',
            message: `Failed to forward request: ${error.message}`,
            timestamp: new Date().toISOString()
        }));
    }
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log('🚀 REST API Proxy Server Started');
    console.log('='.repeat(60));
    console.log(`📍 Listening on: 0.0.0.0:${PORT}`);
    console.log(`🌐 Access via: http://localhost:${PORT}`);
    console.log(`                http://YOUR_IP:${PORT}`);
    console.log('');
    console.log('📋 Active Routes:');
    console.log(''.padEnd(60, '-'));
    
    config.routes.forEach((route, index) => {
        const status = route.enabled ? '✅' : '❌';
        console.log(`${status} ${route.path.padEnd(15)} → ${route.target}`);
        if (route.description) {
            console.log(`   ${route.description}`);
        }
        if (index < config.routes.length - 1) console.log('');
    });
    
    console.log(''.padEnd(60, '-'));
    console.log('👁️  Watching config.json for changes...');
    console.log('='.repeat(60));
});

// Handle server errors
server.on('error', (error) => {
    console.error('Server error:', error.message);
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use!`);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    fs.unwatchFile('config.json');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
