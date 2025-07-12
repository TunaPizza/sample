const express = require('express');
const expressWs = require('express-ws');

const app = express();
expressWs(app);

const port = process.env.PORT || 3001;

// --- グローバルなゲーム状態管理変数 ---
let connects = []; // 全てのWebSocket接続を保持
let chatHistory = []; // チャット履歴
let players = new Set(); // 参加しているプレイヤーのID (Setで重複なし)
let gamePhase = 'idle'; // 現在のゲームフェーズ: 'idle', 'drawing', 'answering'
let turnOrder = []; // ターンの順番 (プレイヤーIDの配列)
let currentTurnIndex = 0; // 現在のターンのプレイヤーの turnOrder 内のインデックス
let currentRound = 1; // 現在のラウンド数
let maxRounds = 3; // 最大ラウンド数 (クライアントから設定可能)
let firstChar = ''; // 現在のお題の最初の文字
let gameTimer = null; // サーバーサイドのタイマーの Interval ID
let timeLeft = 0; // 現在のフェーズの残り時間 (秒)

const DRAWING_TIME_LIMIT = 30; // 描画時間の制限（秒）
const ANSWERING_TIME_LIMIT = 15; // 回答時間の制限（秒）
// --- ---

// 静的ファイルの提供 (index.html, style.css, script.js など)
app.use(express.static('public')); // 'public' フォルダにクライアント側のファイルがあることを想定

// WebSocket エンドポイント
app.ws('/ws', (ws, req) => {
    connects.push(ws);
    console.log('New WebSocket connection established.');

    // 新規接続時に現在のゲーム状態を送信し、UIを同期させる
    ws.send(JSON.stringify({
        type: 'init',
        players: Array.from(players),
        chatHistory: chatHistory,
        gamePhase: gamePhase,
        turnOrder: turnOrder,
        currentTurnIndex: currentTurnIndex,
        currentRound: currentRound,
        maxRounds: maxRounds,
        firstChar: firstChar,
        timeLeft: timeLeft // 現在の残り時間
    }));

    // 全クライアントに現在の参加者リストをブロードキャスト (新規接続で更新されたため)
    broadcastPlayers();

    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        console.log('Received:', msg.type, 'from', msg.id || 'N/A'); // ログを改善

        switch (msg.type) {
            case 'join':
                // 既にプレイヤーリストにいる場合は何もしない
                if (!players.has(msg.id)) {
                    players.add(msg.id);
                    // WebSocketオブジェクトにプレイヤーIDを紐づける (退出時処理のため)
                    ws.playerId = msg.id;
                    console.log(`Player ${msg.id} joined.`);
                    broadcastPlayers(); // 全クライアントにプレイヤーリスト更新を通知
                    broadcastMessage({ type: 'chat', id: msg.id, text: 'が入室しました' }); // 入室メッセージをブロードキャスト
                }
                break;

            case 'start':
                // ゲームがアイドル状態でない、またはプレイヤーが0人の場合は開始しない
                if (gamePhase !== 'idle') {
                    ws.send(JSON.stringify({ type: 'error', message: 'ゲームは既に開始しています。' }));
                    return;
                }
                if (players.size === 0) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ゲームを開始するには、少なくとも1人以上のプレイヤーが必要です。' }));
                    return;
                }

                // ゲーム状態の初期化と開始
                maxRounds = msg.rounds || 3; // クライアントからの設定、なければデフォルト3
                firstChar = getRandomHiragana();
                turnOrder = Array.from(players).sort(() => Math.random() - 0.5); // プレイヤーをシャッフル
                currentTurnIndex = 0;
                currentRound = 1;
                gamePhase = 'drawing';
                timeLeft = DRAWING_TIME_LIMIT; // 描画フェーズの初期時間

                console.log(`Game started! First Char: ${firstChar}, Turn Order: ${turnOrder.join(' -> ')}`);
                
                broadcastGameState(); // 全クライアントにゲーム開始と最初の状態をブロードキャスト
                startServerTimer(DRAWING_TIME_LIMIT, handleDrawingTimeUp); // サーバータイマー開始
                break;

            case 'drawing_finished':
                // 現在の描画者からのメッセージか、かつ描画フェーズかを確認
                if (gamePhase === 'drawing' && turnOrder[currentTurnIndex] === msg.id) {
                    console.log(`Player ${msg.id} finished drawing.`);
                    clearInterval(gameTimer); // タイマー停止
                    moveToAnsweringPhase(); // 回答フェーズへ移行
                } else {
                    console.log(`Blocked drawing_finished from ${msg.id}: Not their turn or not drawing phase.`);
                    ws.send(JSON.stringify({ type: 'error', message: '今はあなたの描画ターンではありません。' }));
                }
                break;

            case 'submit_answer':
                // 現在の回答者からのメッセージか、かつ回答フェーズかを確認
                if (gamePhase === 'answering' && turnOrder[currentTurnIndex] === msg.id) {
                    console.log(`Player ${msg.id} submitted answer: "${msg.answer}"`);
                    // 回答をチャットに流す
                    broadcastMessage({ type: 'chat', id: msg.id, text: `「${msg.answer}」と回答しました！` });
                    clearInterval(gameTimer); // タイマー停止
                    moveToNextTurn(); // 次のターンへ移行
                } else {
                    console.log(`Blocked submit_answer from ${msg.id}: Not their turn or not answering phase.`);
                    ws.send(JSON.stringify({ type: 'error', message: '今はあなたの回答ターンではありません。' }));
                }
                break;

            case 'chat':
                // チャットは常に許可
                chatHistory.push({ id: msg.id, text: msg.text });
                broadcastMessage(msg); // 全クライアントにチャットメッセージをブ_ロードキャスト
                break;

            case 'paint': // 描画データのリレー
                // 描画フェーズ中で、かつ現在の描画者からのメッセージであるかを確認
                if (gamePhase === 'drawing' && turnOrder[currentTurnIndex] === msg.id) {
                    broadcastMessage(msg);
                } else {
                    // 許可されていない描画は無視
                    // console.log(`Blocked paint from ${msg.id}. Not drawing phase or not their turn.`);
                }
                break;
            case 'clear_canvas': // キャンバスクリアのリレー
                // 描画フェーズ中で、かつ現在の描画者からのメッセージであるかを確認
                if (gamePhase === 'drawing' && turnOrder[currentTurnIndex] === msg.id) {
                    broadcastMessage(msg); // 全クライアントにクリア指示をブロードキャスト
                } else {
                    // 許可されていないクリアは無視
                    // console.log(`Blocked clear_canvas from ${msg.id}. Not drawing phase or not their turn.`);
                }
                break;

            default:
                console.log('Unknown message type:', msg.type);
                break;
        }
    });

    ws.on('close', () => {
        console.log(`WebSocket connection closed for player ${ws.playerId || 'unknown'}.`);
        // 接続が切れたソケットをconnectsリストから削除
        connects = connects.filter((conn) => conn !== ws);
        // プレイヤーIDが紐づけられていればplayersセットから削除
        if (ws.playerId && players.has(ws.playerId)) {
            players.delete(ws.playerId);
            broadcastPlayers(); // プレイヤーリスト更新を通知
            broadcastMessage({ type: 'chat', id: ws.playerId, text: 'が退出しました' }); // 退出メッセージ
            // もし退出したプレイヤーが現在のターンだった場合、ゲーム進行を調整するロジックが必要になる
            // (例: 次のターンへ強制移行など)
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket Error:', error);
    });
});

// --- ヘルパー関数 ---

/**
 * 全ての接続中のクライアントにメッセージをブロードキャストする
 * @param {object} message - 送信するJSONオブジェクト
 */
function broadcastMessage(message) {
    const jsonMessage = JSON.stringify(message);
    connects.forEach((socket) => {
        if (socket.readyState === 1) { // WebSocket.OPEN 状態のソケットのみに送信
            socket.send(jsonMessage);
        }
    });
}

/**
 * 全クライアントに現在のプレイヤーリストをブロードキャストする
 */
function broadcastPlayers() {
    broadcastMessage({
        type: 'players',
        players: Array.from(players),
    });
}

/**
 * 全クライアントに現在のゲーム状態をブロードキャストする
 */
function broadcastGameState() {
    broadcastMessage({
        type: 'game_state_update',
        gamePhase: gamePhase,
        turnOrder: turnOrder,
        currentTurnIndex: currentTurnIndex,
        currentRound: currentRound,
        maxRounds: maxRounds,
        firstChar: firstChar,
        timeLeft: timeLeft,
        // 現在のプレイヤー名も送る (クライアントで表示するため)
        currentPlayer: turnOrder[currentTurnIndex] ? turnOrder[currentTurnIndex] : null
    });
}

/**
 * サーバーサイドタイマーを開始する
 * @param {number} duration - タイマーの初期時間（秒）
 * @param {function} onTimeUpCallback - 時間切れ時に実行するコールバック関数
 */
function startServerTimer(duration, onTimeUpCallback) {
    clearInterval(gameTimer); // 既存のタイマーをクリア
    timeLeft = duration;
    broadcastMessage({ type: 'timer_update', timeLeft: timeLeft }); // 初期残り時間をクライアントに送信

    gameTimer = setInterval(() => {
        timeLeft--;
        broadcastMessage({ type: 'timer_update', timeLeft: timeLeft }); // 毎秒、残り時間をブロードキャスト
        
        if (timeLeft <= 0) {
            clearInterval(gameTimer);
            onTimeUpCallback(); // 時間切れ時のコールバックを実行
        }
    }, 1000); // 1秒ごとに実行
}

/**
 * 描画時間切れ時の処理
 */
function handleDrawingTimeUp() {
    console.log("Server: Drawing time up. Moving to answering phase.");
    moveToAnsweringPhase();
}

/**
 * 回答時間切れ時の処理
 */
function handleAnsweringTimeUp() {
    console.log("Server: Answering time up. Moving to next turn.");
    moveToNextTurn();
}

/**
 * 回答フェーズへ移行する
 */
function moveToAnsweringPhase() {
    gamePhase = 'answering';
    timeLeft = ANSWERING_TIME_LIMIT;
    broadcastGameState(); // 新しいゲーム状態（フェーズ変更）をブロードキャスト
    startServerTimer(ANSWERING_TIME_LIMIT, handleAnsweringTimeUp); // 回答フェーズタイマー開始
}

/**
 * 次のターンへ移行する
 */
function moveToNextTurn() {
    currentTurnIndex++;
    if (currentTurnIndex >= turnOrder.length) {
        currentTurnIndex = 0; // 全員が一周したら最初のプレイヤーに戻る
        currentRound++; // ラウンド増加
    }

    if (currentRound > maxRounds) {
        // ゲーム終了条件を満たした場合
        console.log("Server: Game Over!");
        gamePhase = 'idle'; // ゲームをアイドル状態に
        firstChar = ''; // お題をリセット
        timeLeft = 0; // 残り時間を0に
        broadcastGameState(); // 最終的なゲーム状態をブロードキャスト
        broadcastMessage({ type: 'game_over' }); // ゲーム終了を明示的に通知
        // 必要に応じてスコア計算や結果表示ロジックを追加
    } else {
        // 次のターンのお題とフェーズを設定
        firstChar = getRandomHiragana(); // 新しいお題をランダムに決定
        gamePhase = 'drawing'; // 次のターンは描画フェーズから開始
        timeLeft = DRAWING_TIME_LIMIT;
        broadcastGameState(); // 新しいゲーム状態（ターン、ラウンド、お題、フェーズ）をブロードキャスト
        startServerTimer(DRAWING_TIME_LIMIT, handleDrawingTimeUp); // 次の描画フェーズタイマー開始
    }
}

/**
 * ひらがな1文字をランダムに選ぶ
 * @returns {string} ランダムなひらがな一文字
 */
function getRandomHiragana() {
    const hira = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
    return hira[Math.floor(Math.random() * hira.length)];
}

// サーバー起動
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});