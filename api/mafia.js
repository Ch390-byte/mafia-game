

import { createClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID, randomInt } from 'node:crypto';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const makeCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join('');
};

const makeToken = () => randomBytes(24).toString('hex');

async function getRoom(db, code) {
  const { data, error } = await db
    .from('mafia_rooms')
    .select('state')
    .eq('code', code)
    .maybeSingle();

  if (error) throw error;
  return data?.state || null;
}

async function saveRoom(db, code, state) {
  const { error } = await db.from('mafia_rooms').upsert({
    code,
    state,
    updated_at: new Date().toISOString(),
  });

  if (error) throw error;
}

function getPlayer(state, id, token) {
  const player = state.players.find(
    p => p.id === id && p.token === token
  );

  if (!player) {
    throw new Error('Your session is not valid. Leave and rejoin the room.');
  }

  return player;
}

function makeView(state, player) {
  return {
    hostId: state.hostId,
    phase: state.phase,
    night: state.night,
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
    })),
    me: {
      id: player.id,
      name: player.name,
      role: state.phase === 'lobby' ? 'Not assigned' : player.role,
      alive: player.alive,
    },
    lastEvent: state.lastEvent,
    winner: state.winner,
    publicChat: state.publicChat,
    mafiaChat: player.role === 'Mafia' ? state.mafiaChat : [],
  };
}

function checkWin(state) {
  const alive = state.players.filter(p => p.alive);
  const mafia = alive.filter(p => p.role === 'Mafia').length;
  const town = alive.length - mafia;

  if (mafia === 0) state.winner = 'Villagers';
  else if (mafia >= town) state.winner = 'Mafia';

  if (state.winner) state.phase = 'ended';
}

export default async function handler(req, res) {
  Object.entries(cors).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed.',
    });
  }

  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new Error('Server database settings are missing.');
    }

    const db = createClient(url, key, {
      auth: { persistSession: false },
    });

    let b = req.body;
    if (typeof b === 'string') b = JSON.parse(b);
    if (!b || typeof b !== 'object') {
      throw new Error('Invalid request body.');
    }

    const action = b.action;
    let code = String(b.roomCode || '').toUpperCase();
    let state = null;
    let player = null;

    if (action === 'create') {
      const name = String(b.name || '').trim().slice(0, 18);
      if (!name) throw new Error('Enter a player name.');

      let roomCode = makeCode();
      while (await getRoom(db, roomCode)) {
        roomCode = makeCode();
      }

      const id = randomUUID();
      const token = makeToken();

      state = {
        hostId: id,
        phase: 'lobby',
        players: [{
          id,
          token,
          name,
          role: '',
          alive: true,
        }],
        night: 0,
        votes: {},
        actions: {},
        mafiaChat: [],
        publicChat: [],
        lastEvent: 'The room is open. Waiting for players.',
        winner: null,
      };

      await saveRoom(db, roomCode, state);

      return res.status(200).json({
        ok: true,
        session: {
          roomCode,
          playerId: id,
          token,
        },
        room: makeView(state, state.players[0]),
      });
    }

    if (action === 'join') {
      const name = String(b.name || '').trim().slice(0, 18);
      code = String(b.joinCode || '').toUpperCase();

      if (!name) throw new Error('Enter a player name.');

      state = await getRoom(db, code);
      if (!state) throw new Error('Room not found. Check the code.');
      if (state.phase !== 'lobby') {
        throw new Error('This game has already started.');
      }
      if (state.players.length >= 30) {
        throw new Error('This room is full.');
      }
      if (state.players.some(
        p => p.name.toLowerCase() === name.toLowerCase()
      )) {
        throw new Error('That name is already in use.');
      }

      const id = randomUUID();
      const token = makeToken();
      const newPlayer = {
        id,
        token,
        name,
        role: '',
        alive: true,
      };

      state.players.push(newPlayer);
      await saveRoom(db, code, state);

      return res.status(200).json({
        ok: true,
        session: { roomCode: code, playerId: id, token },
        room: makeView(state, newPlayer),
      });
    }

    state = await getRoom(db, code);
    if (!state) throw new Error('Room not found.');

    player = getPlayer(
      state,
      String(b.playerId || ''),
      String(b.token || '')
    );

    if (action === 'state') {
      return res.status(200).json({
        ok: true,
        room: makeView(state, player),
      });
    }

    if (action === 'start') {
      if (player.id !== state.hostId) {
        throw new Error('Only the host can start the game.');
      }
      if (state.phase !== 'lobby') {
        throw new Error('The game has already started.');
      }
      if (state.players.length < 5) {
        throw new Error('At least 5 players are required.');
      }

      const shuffled = [...state.players];

      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const mafiaCount = Math.max(
        1,
        Math.floor(state.players.length / 4)
      );

      shuffled.forEach((p, i) => {
        p.role = i < mafiaCount
          ? 'Mafia'
          : i === mafiaCount
            ? 'Doctor'
            : i === mafiaCount + 1
              ? 'Detective'
              : 'Villager';
      });

      state.phase = 'night';
      state.night = 1;
      state.lastEvent = 'Night 1 has begun. Special roles, submit your actions.';
      state.actions = {};
      state.votes = {};
    }

    else if (action === 'nightAction') {
      if (state.phase !== 'night' || !player.alive) {
        throw new Error('You cannot act right now.');
      }
      if (!['Mafia', 'Doctor', 'Detective'].includes(player.role)) {
        throw new Error('Your role has no night action.');
      }

      const target = state.players.find(
        p => p.id === b.targetId && p.alive
      );

      if (!target) throw new Error('Choose a living player.');
      if (player.role !== 'Doctor' && target.id === player.id) {
        throw new Error('You cannot choose yourself.');
      }

      state.actions[player.id] = target.id;

      const message = player.role === 'Detective'
        ? (target.role === 'Mafia'
          ? `${target.name} is Mafia.`
          : `${target.name} is not Mafia.`)
        : 'Your night action has been recorded.';

      await saveRoom(db, code, state);

      return res.status(200).json({
        ok: true,
        room: makeView(state, player),
        message,
      });
    }

    else if (action === 'endNight') {
      if (player.id !== state.hostId) {
        throw new Error('Only the host can end the night.');
      }
      if (state.phase !== 'night') {
        throw new Error('It is not night.');
      }

      const mafia = state.players.filter(
        p => p.alive && p.role === 'Mafia'
      );
      const doctor = state.players.find(
        p => p.alive && p.role === 'Doctor'
      );

      const votes = mafia
        .map(p => state.actions[p.id])
        .filter(Boolean);

      const target = votes.length
        ? votes.sort(
            (x, y) =>
              votes.filter(v => v === y).length -
              votes.filter(v => v === x).length
          )[0]
        : null;

      const protectedId = doctor
        ? state.actions[doctor.id]
        : null;

      if (target && target !== protectedId) {
        const victim = state.players.find(p => p.id === target);
        if (victim) {
          victim.alive = false;
          state.lastEvent = `${victim.name} was eliminated during the night.`;
        }
      } else {
        state.lastEvent = target
          ? "The Doctor saved the Mafia's target. No one was eliminated."
          : 'The night passed quietly. No one was eliminated.';
      }

      checkWin(state);
      if (!state.winner) state.phase = 'day';

      state.actions = {};
      state.votes = {};
    }

    else if (action === 'vote') {
      if (state.phase !== 'day' || !player.alive) {
        throw new Error('Voting is not open for you.');
      }

      const target = state.players.find(
        p => p.id === b.targetId && p.alive && p.id !== player.id
      );

      if (!target) {
        throw new Error('Choose a living player other than yourself.');
      }

      state.votes[player.id] = target.id;
      state.lastEvent = 'A vote has been recorded.';
    }

    else if (action === 'endDay') {
      if (player.id !== state.hostId) {
        throw new Error('Only the host can close voting.');
      }
      if (state.phase !== 'day') {
        throw new Error('It is not day.');
      }

      const counts = Object.values(state.votes).reduce((out, id) => {
        out[id] = (out[id] || 0) + 1;
        return out;
      }, {});

      const max = Math.max(0, ...Object.values(counts));
      const winners = Object.keys(counts).filter(
        id => counts[id] === max
      );

      if (max === 0 || winners.length !== 1) {
        state.lastEvent = 'The vote was tied or no votes were cast. Nobody was eliminated.';
      } else {
        const out = state.players.find(p => p.id === winners[0]);
        if (out) {
          out.alive = false;
          state.lastEvent = `${out.name} was voted out.`;
        }
      }

      checkWin(state);

      if (!state.winner) {
        state.phase = 'night';
        state.night++;
        state.lastEvent += ` Night ${state.night} has begun.`;
      }

      state.votes = {};
      state.actions = {};
    }

    else if (action === 'chat') {
      const message = String(b.text || '').trim().slice(0, 240);

      if (!message) throw new Error('Type a message first.');
      if (!player.alive) {
        throw new Error('Eliminated players cannot chat.');
      }

      const item = {
        name: player.name,
        text: message,
        at: new Date().toISOString(),
      };

      if (player.role === 'Mafia' && state.phase === 'night') {
        state.mafiaChat.push(item);
      } else if (state.phase === 'day') {
        state.publicChat.push(item);
      } else {
        throw new Error('Chat is available to Mafia at night and everyone during the day.');
      }

      state.mafiaChat = state.mafiaChat.slice(-80);
      state.publicChat = state.publicChat.slice(-100);
    }

    else if (action === 'reset') {
      if (player.id !== state.hostId) {
        throw new Error('Only the host can reset the game.');
      }

      state.phase = 'lobby';
      state.winner = null;
      state.night = 0;
      state.votes = {};
      state.actions = {};
      state.mafiaChat = [];
      state.publicChat = [];
      state.lastEvent = 'New game lobby. The host can start when everyone is ready.';

      state.players.forEach(p => {
        p.role = '';
        p.alive = true;
      });
    }

    else {
      throw new Error('Unknown action.');
    }

    await saveRoom(db, code, state);

    return res.status(200).json({
      ok: true,
      room: makeView(state, player),
    });

  } catch (error) {
    console.error('Mafia API error:', error);

    return res.status(400).json({
      ok: false,
      error: error instanceof Error
        ? error.message
        : 'Unexpected server error.',
    });
  }
}
