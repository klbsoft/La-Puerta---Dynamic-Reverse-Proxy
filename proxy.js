const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const PROXY_NAME = "La Puerta";
// Load config with reloading capability
let config = loadConfig();
let PORT = config['service-port'] || 3000;

const MAX_REQUEST = config['max-request'] || 100;
const REQUEST_WINDOW = config['request-window'] || 60000;
const RESET_RATE_LIMIT = config['reset-rate-limit'] || 300000;
const RESET_WINDOW_WITHIN = config['reset-window-within'] || 60;

// ========== RATE LIMITING ==========
const rateLimit = new Map(); // Store request counts per IP

    // Clean up old entries every 5 minutes
   setInterval(() => {
        const now = Date.now();
        for (const [ip, data] of rateLimit.entries()) {
            if (now - data.resetTime > 0) {
                rateLimit.delete(ip);
            }
        }
    }, RESET_RATE_LIMIT); // 5 minutes

function checkRateLimit(req) {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    const windowMs = REQUEST_WINDOW; // 1 minute window
    const maxRequests = MAX_REQUEST; // SAME LIMIT FOR EVERYONE
    
    if (!rateLimit.has(ip)) {
        rateLimit.set(ip, {
            count: 1,
            resetTime: now + windowMs
        });
        return { 
            allowed: true,
        };
    }
    
    const record = rateLimit.get(ip);
    
    // Reset if window expired
    if (now > record.resetTime) {
        record.count = 1;
        record.resetTime = now + windowMs;
        return { 
            allowed: true, 
            remaining: maxRequests - 1,
            resetIn: RESET_WINDOW_WITHIN
        };
    }
    
    // Check if over limit
    if (record.count >= maxRequests) {
        return { 
            allowed: false, 
            remaining: 0,
            resetIn: Math.ceil((record.resetTime - now) / 1000)
        };
    }
    
    record.count++;
    return { 
        allowed: true, 
        remaining: maxRequests - record.count,
        resetIn: Math.ceil((record.resetTime - now) / 1000)
    };
}
// ========== END RATE LIMITING ==========

// ========== LOGGING FUNCTION ==========
const logStream = fs.createWriteStream('proxy-access.log', { flags: 'a' });

function logRequest(req, additionalInfo = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        localTime: new Date().toLocaleTimeString(),
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        method: req.method,
        url: req.url,
        headers: req.headers,
        httpVersion: req.httpVersion,
        additionalInfo: additionalInfo
    };
    
    // Write to file (pretty printed for readability, but you can remove the spaces for smaller files)
  logStream.write(JSON.stringify(logEntry, null, 2) + '\n');
    
    // Also keep your console log for real-time viewing
    console.log(`[${logEntry.localTime}] ${logEntry.method} ${logEntry.url} from ${logEntry.remoteAddress}`);
    
    return logEntry;
}
// ========== END LOGGING FUNCTION ==========


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

// Helper: Forward request
async function forwardRequest(req, targetUrl) {
    return new Promise((resolve, reject) => {
        const url = new URL(targetUrl);
        const httpModule = getHttpModule(url);
        
        // Prepare headers (remove host, add x-forwarded headers)
        const headers = { ...req.headers };
        delete headers.host; // Target server will set its own host
        
        // Add forwarding headers
        headers['x-forwarded-for'] = req.socket.remoteAddress;
        headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
        headers['x-forwarded-host'] = req.headers.host;
        
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: req.method,
            headers: headers,
            timeout: 10000 // 10 second timeout
        };
        
        const proxyReq = httpModule.request(options, (proxyRes) => {
            let body = [];
            proxyRes.on('data', (chunk) => body.push(chunk));
            proxyRes.on('end', () => {
                const response = {
                    statusCode: proxyRes.statusCode,
                    headers: proxyRes.headers,
                    body: Buffer.concat(body)
                };
                resolve(response);
            });
        });
        
        proxyReq.on('error', reject);
        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            reject(new Error('Request timeout'));
        });
        
        // Forward request body if present
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            req.pipe(proxyReq);
        } else {
            proxyReq.end();
        }
    });
}

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
    logRequest(req);    
    
    console.log(`[${timestamp}] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    // ===== RATE LIMITING CHECK =====
const rateCheck = checkRateLimit(req);

// Add rate limit headers
// res.setHeader('X-RateLimit-Limit', 100);
// res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);

if (!rateCheck.allowed) {
   // res.setHeader('X-RateLimit-Reset', rateCheck.resetIn);
    
    logRequest(req, { 
        blocked: 'rate_limit_exceeded',
        resetIn: rateCheck.resetIn
    });
    
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        error: 'Too Many Requests',
        proxy: PROXY_NAME
    }));
    console.log(`🚨 LIMIT REACHED - IP: ${req.socket.remoteAddress} - URL: ${req.url} - Method: ${req.method}`);
    return;
}
// ===== END RATE LIMITING CHECK =====



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
        console.log(`Request - IP: ${req.socket.remoteAddress} - URL: ${req.url} - Method: ${req.method}`);

        
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
