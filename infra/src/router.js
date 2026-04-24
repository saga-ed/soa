import express from 'express';
import * as handlers from './handlers.js';

/**
 * Create an Express Router that exposes infra-compose operations over HTTP.
 *
 * Mount it in your app:
 *   app.use('/infra', create_router({ on_after_switch: restart_my_app }))
 *
 * @param {import('./router.js').InfraRouterOptions} [options]
 * @returns {express.Router}
 */
export function create_router(options = {}) {
    const router = express.Router();
    router.use(express.json());

    /**
     * Wrap a handler function into an Express route handler.
     * Merges body + query into handler input, runs optional lifecycle hook on success.
     */
    const wrap = (fn, hook_name) => async (req, res) => {
        try {
            const { output_dir: _output_dir, data_dir: _data_dir, seed_dir: _seed_dir, ...safe } = { ...req.query, ...req.body };
            const input = { ...safe, compose_file: options.compose_file };
            const result = await fn(input);
            if (result.ok && hook_name && options[hook_name]) {
                await options[hook_name](result);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message || String(err) });
        }
    };

    router.post('/snapshot',       wrap(handlers.handle_snapshot, 'on_after_snapshot'));
    router.post('/switch',         wrap(handlers.handle_switch, 'on_after_switch'));
    router.post('/reset',          wrap(handlers.handle_reset, 'on_after_reset'));
    router.post('/restore',        wrap(handlers.handle_restore));
    router.get('/profiles',        wrap(handlers.handle_list_profiles));
    router.post('/delete-profile', wrap(handlers.handle_delete_profile));
    router.get('/active-profile',  wrap(handlers.handle_get_active));

    router.get('/health', (_req, res) => {
        const active = handlers.handle_get_active();
        res.json({ ok: true, service: 'infra-compose', ...active });
    });

    return router;
}
