const express = require('express');
const bodyParser = require('body-parser');

const WebSocketClient = require("websocket").client;

const {VapiClient} = require('@vapi-ai/server-sdk');

const app = express();
app.use(bodyParser.json());

app.use(bodyParser.urlencoded({extended: true}));

const vapiClient = new VapiClient({
    token: process.env.VAPI_TOKEN
});

const sessions = {};


const getWebSocketClient = async () => {
    const client = new WebSocketClient();
    client.on('connectFailed', (error) => {
        console.log('Connect Error: ' + error.toString());
    });
    return client;
}


const splitChannels = (dataBuffer) => {

    if (!Buffer.isBuffer(dataBuffer)) {
        throw new TypeError("Input must be a Buffer");
    }
    if (dataBuffer.length % 4 !== 0) {
        console.warn("Buffer length is not a multiple of 4. Truncated data may exist.");
    }

    const leftChannel = [];
    const rightChannel = [];

    // Process buffer in 4-byte chunks (2 bytes per channel)
    for (let i = 0; i < dataBuffer.length; i += 4) {
        if (i + 3 < dataBuffer.length) {
            const leftSample = dataBuffer.readInt16LE(i);
            const rightSample = dataBuffer.readInt16LE(i + 2);
            leftChannel.push(leftSample);
            rightChannel.push(rightSample);
        }
    }

    const leftBuffer = Buffer.alloc(leftChannel.length * 2);
    const rightBuffer = Buffer.alloc(rightChannel.length * 2);

    for (let i = 0; i < leftChannel.length; i++) {
        leftBuffer.writeInt16LE(leftChannel[i], i * 2);
    }

    for (let i = 0; i < rightChannel.length; i++) {
        rightBuffer.writeInt16LE(rightChannel[i], i * 2);
    }

    return {leftBuffer, rightBuffer};
}

const getAccessToken = async (appId = process.env.SYMBL_APP_ID,
                                     appSecret = process.env.SYMBL_APP_SECRET) => {
    const res = await fetch('https://api.symbl.ai/oauth2/token:generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            type: 'application',
            appId,
            appSecret,
        }),
    });
    if (res.status !== 200) {
        throw new Error(`Failed to get Symbl access token: ${res.statusText}`);
    }
    const resBody = await res.json();
    return resBody.accessToken;
}

const connectToRTAEndpoint = async (sessionId, rtaId) => {
    const client = await getWebSocketClient();
    const symblToken = await getAccessToken();

    const rtaUrl = `wss://api.symbl.ai/v1/realtime/assist/${rtaId}?access_token=${symblToken}`;
    // const rtaUrl = `wss://api.symbl.ai/v1/streaming/${sessionId}?access_token=${symblToken}`;
    client.connect(rtaUrl, null, null, null, {
        rejectUnauthorized: false
    });

    return client;
}

const onRTAConnect = async (connection, options = {}) => {
    const {sessionId, rtaId, speaker} = options;
    const _role = speaker.role;
    console.log(`Connected to Symbl RTA as ${_role}`);
    connection.on('error', async (error) => {
        console.log("Connection Error: " + error.toString());
    });
    connection.on('close', async () => {
        console.log('RTA connection closed', sessionId, _role);
    });

    connection.on('message', async (message) => {
        if (message.type === 'utf8') {
            const msg = JSON.parse(message.utf8Data);
            if (msg.type === 'error') {
                console.error('Error response received:', JSON.stringify(msg, null, 2));
                connection.close();
                return;
            }


            if (msg.type === 'objection_response') {
                console.log('Objection Response:', JSON.stringify(msg, null, 2));
            }

            if (msg.message && msg.message.type === 'recognition_started') {
                console.log('Recognition Started:', JSON.stringify(msg, null, 2));
            }

            if (msg.message && msg.message.type === "recognition_result") {
                console.log(msg.message.user.role, msg.message.punctuated.transcript);
            }

            if (msg.message && msg.message.type === "conversation_completed") {
                console.log('Conversation Completed:', JSON.stringify(msg, null, 2));
                connection.close();
            }
        }
    });

    console.log('Sending start request to RTA', sessionId, _role);

    connection.send(JSON.stringify({
        type: 'start_request',
        id: sessionId,
        RTAId: rtaId,
        speaker: {
            userId: speaker.userId,
            name: speaker.name,
            role: speaker.role
        },
        assistants: ["objection-handling"],
        config: {
            speechRecognition: {
                encoding: "LINEAR16",
                sampleRateHertz: 16000
            }
        }
    }));

}

const assistantId = process.env.ASSISTANT_ID;
const phoneNumberId = process.env.PHONE_NUMBER_ID;

const agentName = process.env.AGENT_NAME || "Ava";

app.post('/start-call', async (req, res) => {
    let call = await vapiClient.calls.create({
        assistantId: assistantId,
        phoneNumberId: phoneNumberId,
        customer: {
            name: req.body.customer.name,
            number: req.body.customer.number
        }
    });

    const id = call.id;
    const listenUrl = call.monitor.listenUrl;

    sessions[id] = {}

    const agent_ws = await connectToRTAEndpoint(id, process.env.RTA_ID);
    const customer_ws = await connectToRTAEndpoint(id, process.env.RTA_ID);

    customer_ws.on('connect', async (con) => {
        sessions[id]['customer'] = con;
        await onRTAConnect(con, {
            sessionId: id,
            rtaId: process.env.RTA_ID,
            speaker: {userId: call.customer.number, name: call.customer.name, role: 'customer'}
        });
    });

    agent_ws.on('connect', async (con) => {
        sessions[id]['agent'] = con;
        await onRTAConnect(con, {
            sessionId: id,
            rtaId: process.env.RTA_ID,
            speaker: {userId: call.phoneNumberId, name: agentName, role: 'agent'}
        });
    });

    call = await vapiClient.calls.get(call.id)
    while (call.status !== 'in-progress') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        call = await vapiClient.calls.get(call.id);
        if (call.status === 'failed') {
            throw new Error("Call failed to connect.");
        } else if (call.status === 'completed') {
            throw new Error("Call completed before connecting to RTA.");
        } else {
            console.log("Call status:", call.status);
        }
    }


    // // This is just for demonstration, in a real-world scenario you would wait for the call status to change
    // await new Promise((resolve) => setTimeout(resolve, 10000));

    const client = await getWebSocketClient()
    // Connect to the vapi listenUrl to receive audio data
    console.log("Connecting to websocket", listenUrl);
    client.connect(listenUrl, null, null, null, {
        rejectUnauthorized: false
    });


    client.on('connect', (connection) => {
        console.log('Websocket connected');

        let chunkCount = 0;

        connection.on('message', async (data) => {
            if (data.type === 'utf8') {
                console.log('Received message:', JSON.parse(data.utf8Data));
            }

            if (data.type === 'binary') {
                chunkCount++;
                const binaryData = data.binaryData;
                const {leftBuffer, rightBuffer} = splitChannels(binaryData);
                // console.log('Left Channel:', Buffer.from(leftBuffer));
                // console.log('Right Channel:', Buffer.from(rightBuffer));
                sessions[id]['customer'].sendBytes(leftBuffer);
                sessions[id]['agent'].sendBytes(rightBuffer);

                if (chunkCount % 100 === 0) {
                    console.log(`Processed ${chunkCount} audio chunks so far.`);
                }
            }
        });

        connection.on('error', (error) => {
            console.error("Error in VAPI WebSocket:", error);
            // sessions[id]['customer'].send(JSON.stringify({type: 'stop_request'}));
            sessions[id]['agent'].send(JSON.stringify({type: 'stop_request'}));
        });

        connection.on('close', () => {
            console.log("VAPI WebSocket closed.");
            // sessions[id]['customer'].send(JSON.stringify({type: 'stop_request'}));
            sessions[id]['agent'].send(JSON.stringify({type: 'stop_request'}));
        });
    });

    await new Promise((resolve) => setTimeout(resolve, 600000));

    res.send('Call done.');
});

app.listen(3030, () => {
    console.log('Server started on port 3000');
});
