import pool from './db.js';

export async function authMiddleware(req, res, next) {
    try {
        const auth = req.headers.authorization || '';
        const [type, token] = auth.split(' ');

        if (type !== 'Bearer' || !token) {
            return res
                .status(401)
                .json({ ok: false, error: 'Sem token, sem rolê' });
        }

        const [rows] = await pool.query(
            'SELECT id, email FROM usuarios WHERE api_token = ? LIMIT 1',
            [token]
        );

        if (rows.length < 1) {
            return res
                .status(401)
                .json({ ok: false, error: 'Token inválido, linha dura' });
        }

        req.user = rows[0]; // agora req.user.id tá disponível nas rotas
        next();
    } catch (err) {
        console.error('Erro no authMiddleware:', err);
        return res
            .status(500)
            .json({ ok: false, error: 'Falha na verificação do token' });
    }
}
