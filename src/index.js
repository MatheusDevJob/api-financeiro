// src/index.js
import 'dotenv/config';
import express, { response } from 'express';
import cors from 'cors';
import pool from './db.js';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { authMiddleware } from './authMiddleware.js';

const app = express();

app.use(cors());
app.use(express.json());


app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, senha } = req.body || {};

        if (!email || !senha) {
            return res.status(400).json({ ok: false, error: 'Manda o email e a senha, jumento' });
        }

        const [rows] = await pool.query(
            'SELECT id, nome, email, senha_hash FROM usuarios AS u WHERE email = ? AND ativo = 1 LIMIT 1',
            [email]
        );

        if (rows.length < 1) {
            return res.status(422).json({ ok: false, error: 'Tu nem existe' });
        }

        const user = rows[0];

        const senhaConfere = await bcrypt.compare(senha, user.senha_hash);
        if (!senhaConfere) {
            return res.status(401).json({ ok: false, error: 'Senha errada, lenda do fracasso' });
        }

        const token = randomUUID();

        pool.query(
            'UPDATE usuarios SET api_token = ? WHERE id = ?',
            [token, user.id]
        )

        return res.json({
            ok: true,
            token: token,
            user: {
                id: user.id,
                nome: user.nome,
                email: user.email,
            },
        });
    } catch (err) {
        console.error('Erro em /api/auth/login:', err);
        return res.status(500).json({ ok: false, error: 'Deu erro, otário' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { nome, email, senha } = req.body || {};

        if (!nome || !email || !senha) {
            return res.status(400).json({ ok: false, error: 'Preenche isso direito' });
        }

        const [existe] = await pool.query(
            'SELECT id FROM usuarios WHERE email = ? LIMIT 1',
            [email]
        );

        if (existe.length > 0) {
            return res.status(409).json({ ok: false, error: 'Já tem conta com esse email, doido' });
        }

        const senhaHash = await bcrypt.hash(senha, 10);

        const [result] = await pool.query(
            `
            INSERT INTO usuarios (nome, email, senha_hash)
            VALUES (?, ?, ?)
            `,
            [nome, email, senhaHash]
        );

        return res.json({
            ok: true,
            id: result.insertId,
            email,
        });
    } catch (err) {
        console.error('Erro em /api/auth/register:', err);
        return res.status(500).json({ ok: false, error: 'Explodiu tudo no cadastro' });
    }
});



// GET /api/financas/historico?limite=100
app.get('/api/financas/historico', authMiddleware, async (req, res) => {
    const user_id = req.user.id;
    try {
        const limite = Number(req.query.limite || 100);

        const [rows] = await pool.query(
            `SELECT
                l.id,
                l.tipo,
                l.valor,
                l.descricao,
                l.data_movimento,
                l.saldo_apos,
                c.nome   AS conta_nome,
                cat.nome AS categoria_nome,
                fp.nome  AS forma_pagamento_nome
            FROM lancamentos l
            JOIN contas c                   ON c.id = l.conta_id
            LEFT JOIN categorias cat        ON cat.id = l.categoria_id
            LEFT JOIN formas_pagamento fp   ON fp.id = l.forma_pagamento_id
            WHERE l.usuario_id = ?
            AND l.apagado_em IS NULL
            ORDER BY l.data_movimento DESC, l.id DESC
            LIMIT ?
            `,
            [user_id, limite]
        );

        let saldoTotal = 0;

        if (rows.length > 0 && rows[0].saldo_apos != null) {
            saldoTotal = Number(rows[0].saldo_apos);
        } else {
            const [sumRows] = await pool.query(
                `
            SELECT
            SUM(
                CASE
                WHEN tipo = 'entrada' THEN valor
                WHEN tipo = 'saida'   THEN -valor
                ELSE 0
                END
            ) AS saldo
            FROM lancamentos
            WHERE usuario_id = ? AND apagado_em IS NULL
            `,
                [user_id]
            );
            saldoTotal = Number(sumRows[0].saldo || 0);
        }

        const movimentos = rows.map((row) => ({
            id: row.id,
            tipo: row.tipo,
            valor: Number(row.valor),
            descricao: row.descricao,
            data: row.data_movimento,
            saldoApos: row.saldo_apos != null ? Number(row.saldo_apos) : null,
            contaNome: row.conta_nome,
            categoriaNome: row.categoria_nome,
            formaPagamentoNome: row.forma_pagamento_nome,
        }));

        return res.json({
            ok: true,
            saldoTotal,
            movimentos,
        });
    } catch (err) {
        console.error('Erro em /api/financas/historico:', err);
        return res.status(500).json({
            ok: false,
            error: 'Erro interno ao buscar histórico financeiro',
        });
    }
});

app.post('/api/financas/registrar', authMiddleware, async (req, res) => {
    try {
        const {
            conta_id,
            categoria_id,
            forma_pagamento_id,
            tipo,
            valor,
            descricao
        } = req.body;

        const user_id = req.user.id;

        if (categoria_id) {
            const categoria = await pool.query("SELECT id FROM categorias WHERE id = ? AND usuario_id = ? LIMIT 1", [categoria_id, user_id]);
            if (categoria.length < 1) return res.status(422).json({ "ok": false, error: "Não existe essa categoria, ao menos não pra você, seu bosta!" });
        }

        if (forma_pagamento_id) {
            const formPaga = await pool.query("SELECT id FROM formas_pagamento WHERE id = ? AND usuario_id = ? LIMIT 1", [forma_pagamento_id, user_id]);
            if (formPaga.length < 1) return res.status(422).json({ "ok": false, error: "Não existe essa forma de pagamento, tá querendo me enganar?" });
        }

        const conta = await pool.query("SELECT id FROM contas WHERE id = ? AND usuario_id = ? LIMIT 1", [conta_id, user_id]);
        if (conta.length < 1) return res.status(422).json({ "ok": false, error: "Se essa conta existir, não é sua! Sai daqui, menó!" });

        if (!['entrada', 'saida'].includes(tipo)) return res.status(422).json({ "ok": false, error: "Se tu não tá adicionando nem retirando, ta fazendo o que? Hã?!" });

        if (valor < 1) return res.status(422).json({ "ok": false, error: "Irmão, não tem valor negativo e nem 0... se você gastou, passa o valor e diz que tirou, só isso..." });

        if (descricao.length < 1) return res.status(422).json({ "ok": false, error: "Não existe gasto sem descrição..." });

        const [lancamentos] = await pool.query(`SELECT saldo_apos FROM lancamentos WHERE usuario_id = ? AND saldo_apos IS NOT NULL AND apagado_em IS NULL ORDER BY data_movimento DESC LIMIT 1`, [user_id]);

        let saldo_apos = null;

        if (lancamentos.length > 0) saldo_apos = lancamentos[0]['saldo_apos'];

        // se for entrada de valor e não for em crédito (vai que o imbecil da entrada em crédito?)
        if (forma_pagamento_id != 1) {
            if (tipo == 'entrada') {
                saldo_apos += valor;
            } else if (tipo == 'saida') {
                saldo_apos -= valor;
            }
        }

        await pool.query(
            `INSERT INTO lancamentos 
            (usuario_id, conta_id, categoria_id, forma_pagamento_id, tipo, valor, descricao, data_movimento, saldo_apos) 
            VALUE (?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [user_id, conta_id, categoria_id, forma_pagamento_id, tipo, valor, descricao, saldo_apos]
        );
        return res.status(201).json({ "ok": true, "msg": "Registro salvo, brô 👌" });
    } catch (err) {

        console.error("Deu bosta no registro" + err);
        return res.status(422).json({ "ok": false, error: "Deu bosta do lado de cá." });
    }
});

app.get('/api/financas/necessario', authMiddleware, async (req, res) => {
    const user_id = req.user.id;

    const [categorias] = await pool.query("SELECT id, nome FROM categorias WHERE usuario_id = ?", [user_id]);
    const [contas] = await pool.query("SELECT id, nome FROM contas WHERE usuario_id = ?", [user_id]);
    const [formas_pagamento] = await pool.query("SELECT id, nome FROM formas_pagamento WHERE usuario_id = ?", [user_id]);

    return res.json({
        ok: true,
        categorias,
        contas,
        formas_pagamento,
    });
});

app.get('/api/financas/atual', authMiddleware, async (req, res) => {
    const user_id = req.user.id;

    const [last_registro] = await pool.query(`
        SELECT saldo_apos
        FROM lancamentos
        WHERE usuario_id = ?
        AND apagado_em IS NULL
        ORDER BY id DESC
        LIMIT 1
    `, [user_id]);

    if (last_registro.length < 1)
        return res.json(null);

    return res.json(last_registro[0]['saldo_apos']);
});

app.post('/api/financas/deletar', authMiddleware, async (req, res) => {
    try {
        const user_id = req.user.id;
        const lancId = req.body.lancId;
        await pool.query('UPDATE lancamentos SET apagado_em = NOW() WHERE usuario_id = ? AND id = ?', [user_id, lancId]);
        return res.status(202).json({ "ok": true, "msg": "Removi pra tu, só não se acostuma 😒" });

    } catch (err) {
        console.error("Deu bosta ao apagar" + err);
        return res.status(422).json({ "ok": false, error: "Deu bosta do lado de cá." });
    }
});

app.post('/api/financas/categoria', authMiddleware, async (req, res) => {
    try {
        const { categoria } = req.body;
        const user_id = req.user.id;

        await pool.query(`INSERT INTO categorias (nome, usuario_id) VALUE (?, ?) `, [categoria, user_id]);
        return res.status(422).json({ "ok": true, "msg": "Tá feito, meu truta 😎" });
    } catch (error) {
        console.error('Erro registro categoria: ' + error);
        return res.status(422).json({ "ok": false, error: "Deu bosta do lado de cá." });
    }
});

app.post('/api/financas/conta', authMiddleware, async (req, res) => {
    try {
        const { conta, descricao } = req.body;
        const user_id = req.user.id;

        await pool.query(`INSERT INTO contas (nome, descricao, usuario_id) VALUE (?, ?, ?) `, [conta, descricao, user_id]);
        return res.status(422).json({ "ok": true, "msg": "Tá feito, meu truta 😎" });
    } catch (error) {
        console.error('Erro registro categoria: ' + error);
        return res.status(422).json({ "ok": false, error: "Deu bosta do lado de cá." });
    }
});

app.post('/api/financas/forma_pagamento', authMiddleware, async (req, res) => {
    try {
        const { forma_pagamento } = req.body;
        const user_id = req.user.id;

        await pool.query(`INSERT INTO formas_pagamento (nome, usuario_id) VALUE (?, ?) `, [forma_pagamento, user_id]);
        return res.status(422).json({ "ok": true, "msg": "Tá feito, meu truta 😎" });
    } catch (error) {
        console.error('Erro registro categoria: ' + error);
        return res.status(422).json({ "ok": false, error: "Deu bosta do lado de cá." });
    }
});

const port = process.env.PORT || 1212;
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
