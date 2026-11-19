import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

const logToTerminal = {
    name: 'log-to-terminal',
    configureServer(server) {
        server.middlewares.use('/log', (req, res) => {
            let body = '';
            req.on('data', (c) => {
                if (body.length < 2000) body += c;
            });
            req.on('end', () => {
                console.log(`[${new Date().toLocaleTimeString()}] ${body}`);
                res.statusCode = 204;
                res.end();
            });
        });
    },
};

export default defineConfig({
    plugins: [basicSsl(), logToTerminal],
    server: { host: true, port: 5183 },
});
