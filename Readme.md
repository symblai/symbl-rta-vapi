# Symbl RTA with vapi.ai
This is a sample application to demonstrate how to integrate Symbl Real-Time APIs with vapi.ai.

## Pre-requisites
Node.js (>= v20.0.0)

## Setup
```bash
npm install
```

## Run
Make sure you have the details set in the environment variables before running the application.
```bash
VAPI_TOKEN=<your_vapi_token> \
ASSISTANT_ID=<vapi_assistant_id> \
PHONE_NUMBER_ID=<phone_number_id> \
AGENT_NAME=<name_of_the_virtual_assistant> \
SYMBL_APP_ID=<your_app_id> \
SYMBL_APP_SECRET=<your_app_secret> \
RTA_ID=<rta_id> \
    npm start
```
Symbl RTA API Docs: https://docs.symbl.ai/docs/getting-started-with-real-time-assist-rta-api
VAPI Listen API docs - https://docs.vapi.ai/calls/call-features#call-listen-feature
