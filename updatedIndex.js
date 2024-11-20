const express = require('express');
const bodyParser = require('body-parser');
const WebSocketClient = require("websocket").client;
const {v4: uuidv4} = require('uuid');
require('dotenv').config();

const {VapiClient} = require('@vapi-ai/server-sdk');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));

const vapiClient = new VapiClient({
    token: process.env.VAPI_TOKEN
});

async function connectToRTAEndpoint(sessionId, rtaId, role) {
    const client = new WebSocketClient();
    const symblToken = await getSymblAccessToken();

    return new Promise((resolve, reject) => {
        const rtaUrl = `wss://api.symbl.ai/v1/realtime/assist/${rtaId}?access_token=${symblToken}`;

        client.on('connectFailed', (error) => {
            console.error("Symbl WebSocket connection failed:", error);
            reject(error);
        });

        client.on('connect', (connection) => {
            console.log(`Connected to Symbl RTA WebSocket for session: ${sessionId} as ${role}`);

            connection.on('message', (message) => {
                const parsedMessage = JSON.parse(message.utf8Data);
                console.log("Symbl WebSocket Message Received:", parsedMessage);

                if (parsedMessage.type === 'message') {
                    if (parsedMessage.message.type === 'conversation_completed') {
                        connection.close();
                    }
                }

                if (parsedMessage.type === 'insight') {
                    console.log("Insight Detected:", parsedMessage.insight);
                } else if (parsedMessage.type === 'transcript') {
                    console.log("Transcript:", parsedMessage.message.punctuated.transcript);
                } else if (parsedMessage.type === 'error') {
                    console.error("Symbl Error:", parsedMessage.message);
                }
            });

            connection.send(JSON.stringify({
                type: 'start_request',
                id: sessionId,
                RTAId: rtaId,
                assistants: ["objection-handling"],
                config: {
                    speechRecognition: {
                        encoding: "LINEAR16",
                        sampleRateHertz: 16000
                    }
                },
                speaker: {
                    userId: `${role}-${sessionId}`, // Unique ID per role
                    name: role === "customer" ? "Customer" : "Agent",
                    role: role
                }
            }));

            resolve(connection);
        });

        client.connect(rtaUrl);
    });
}


async function getSymblAccessToken() {
    const res = await fetch('https://api.symbl.ai/oauth2/token:generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            type: 'application',
            appId: process.env.SYMBL_APP_ID,
            appSecret: process.env.SYMBL_APP_SECRET,
        }),
    });

    if (res.status !== 200) {
        throw new Error(`Failed to get Symbl access token: ${res.statusText}`);
    }

    const resBody = await res.json();
    return resBody.accessToken;
}

function connectWithRetry(url, retries = 3, delay = 2000) {
    return new Promise((resolve, reject) => {
        const client = new WebSocketClient();

        client.on('connect', (connection) => {
            console.log("Connected to VAPI listen URL.");
            resolve(connection);
        });

        client.on('connectFailed', (error) => {
            console.error("Failed to connect to VAPI listen URL:", error.message);
            if (retries > 0) {
                console.log(`Retrying in ${delay}ms... (${retries} retries left)`);
                setTimeout(() => {
                    connectWithRetry(url, retries - 1, delay).then(resolve).catch(reject);
                }, delay);
            } else {
                reject(new Error("Failed to connect after multiple retries."));
            }
        });

        client.connect(url, null, null, null, {rejectUnauthorized: false});
    });
}


function streamAudioToSymbl(call, customerConnection, agentConnection) {
    const listenUrl = call.monitor.listenUrl;
    console.log("Using listen URL:", listenUrl);

    const vapiClient = new WebSocketClient();
    let chunkCount = 0;

    vapiClient.on('connectFailed', (error) => {
        console.error("Failed to connect to VAPI listen URL:", error);
    });

    vapiClient.on('connect', (vapiConnection) => {
        console.log("Connected to VAPI listen URL.");

        vapiConnection.on('message', async (data) => {
            if (data.type === 'binary') {
                chunkCount++;
                const {leftBuffer, rightBuffer} = splitChannels(data.binaryData);

                if (customerConnection) {
                    customerConnection.sendBytes(leftBuffer);
                }
                if (agentConnection) {
                    agentConnection.sendBytes(rightBuffer);
                }

                // Log every 10th chunk to reduce flooding
                if (chunkCount % 100 === 0) {
                    console.log(`Processed ${chunkCount} audio chunks so far.`);
                }
            } else {
                console.log("Received message from VAPI:", data.utf8Data);
            }
        });

        vapiConnection.on('error', (error) => {
            console.error("Error in VAPI WebSocket:", error);
            customerConnection.send(JSON.stringify({type: 'stop_request'}));
            agentConnection.send(JSON.stringify({type: 'stop_request'}));
        });

        vapiConnection.on('close', () => {
            console.log("VAPI WebSocket closed.");
            customerConnection.send(JSON.stringify({type: 'stop_request'}));
            agentConnection.send(JSON.stringify({type: 'stop_request'}));
        });
    });

    vapiClient.connect(listenUrl, null, null, null, {rejectUnauthorized: false});
}


function splitChannels(dataBuffer) {
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

app.post('/start-call', async (req, res) => {
    const sessionId = uuidv4();
    console.log("Generated sessionId:", sessionId);

    try {
        let call = await vapiClient.calls.create({
            assistantId: process.env.ASSISTANT_ID,
            phoneNumberId: process.env.PHONE_NUMBER_ID,
            customer: {
                name: req.body.customer.name,
                number: req.body.customer.number
            }
        });

        console.log("Call initiated with VAPI.ai");

        const customerConnection = await connectToRTAEndpoint(sessionId, process.env.RTA_ID, 'customer');
        const agentConnection = await connectToRTAEndpoint(sessionId, process.env.RTA_ID, 'agent');
        if (customerConnection && agentConnection) {
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
            console.log("Symbl RTA WebSockets connected for customer and agent.");
            streamAudioToSymbl(call, customerConnection, agentConnection);
        } else {
            console.error("Failed to establish Symbl WebSocket connections.");
        }

        res.send('Call started and audio streaming to Symbl.');
    } catch (error) {
        console.error("Error in /start-call route:", error.message);
        res.status(500).send({error: "Failed to start call", details: error.message});
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
