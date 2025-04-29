import twilio from 'twilio';
import express from 'express';

// Create express app first
const app = express();

// Add request logging middleware BEFORE routes
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// Parse JSON bodies AND URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Validate environment variables
const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'ULTRAVOX_API_KEY',
  'GHL_API_KEY',
  'GHL_LOCATION_ID'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

// Twilio configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// GHL configuration
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_API_URL = 'https://rest.gohighlevel.com/v1';

// Log Twilio configuration (without sensitive data)
console.log('Twilio Configuration:', {
    accountSid: TWILIO_ACCOUNT_SID ? `${TWILIO_ACCOUNT_SID.substring(0, 4)}...` : 'missing',
    phoneNumber: TWILIO_PHONE_NUMBER || 'missing'
});

// Ultravox configuration
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;

// Determine base URL for webhooks
const getServerBaseUrl = () => {
    if (process.env.SERVER_BASE_URL) {
        return process.env.SERVER_BASE_URL;
    }
    
    // For local development
    const port = process.env.PORT || 10000;
    
    // If running in a cloud environment, try to detect the public URL
    if (process.env.VERCEL_URL) {
        return `https://${process.env.VERCEL_URL}`;
    }
    if (process.env.RENDER_EXTERNAL_URL) {
        return process.env.RENDER_EXTERNAL_URL;
    }
    
    // Fallback to localhost
    return `http://localhost:${port}`;
};

function formatPhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    
    // Remove all non-digit characters and trim whitespace
    const digits = phoneNumber.toString().trim().replace(/\D/g, '');
    
    // For Philippines numbers (63 prefix)
    if (digits.startsWith('63')) {
        return `+${digits}`;
    }
    
    // For US numbers (assuming US if no country code provided)
    if (digits.length === 10) {
        return `+1${digits}`;
    }
    
    // If number already includes country code (11+ digits)
    if (digits.length >= 11) {
        // If it starts with 1, assume US/Canada
        if (digits.startsWith('1')) {
            return `+${digits}`;
        }
        // For other international numbers, check if they start with a valid country code
        // For now, we'll support Philippines (63)
        if (digits.startsWith('63')) {
            return `+${digits}`;
        }
    }
    
    return null;
}

// Updated function to format phone number for tagging service
function formatPhoneNumberForTagging(phoneNumber) {
    if (!phoneNumber) return null;
    
    // Remove all non-digit characters including + and spaces
    return phoneNumber.toString().trim().replace(/\D/g, '');
}

// Enhanced sendSMS function with better error handling and logging
async function sendSMS(phoneNumber, message) {
    console.log('\n=== SMS Send Attempt ===');
    console.log('Parameters:', {
        to: phoneNumber,
        messageLength: message.length,
        from: TWILIO_PHONE_NUMBER,
        timestamp: new Date().toISOString()
    });

    try {
        const formattedNumber = formatPhoneNumber(phoneNumber);
        if (!formattedNumber) {
            console.error('Invalid phone number format:', phoneNumber);
            throw new Error('Invalid phone number format');
        }

        console.log('Creating Twilio client...');
        
        // Configure Twilio client with timeout options
        const clientOptions = {
            timeout: 30000, // 30 seconds
            keepAlive: false
        };
        
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, clientOptions);

        console.log('Sending SMS message...');
        const result = await client.messages.create({
            body: message,
            from: TWILIO_PHONE_NUMBER,
            to: formattedNumber,
            attempt: 1,
            maxPrice: 0.15 // Set maximum price per message
        });

        console.log('SMS sent successfully:', {
            sid: result.sid,
            status: result.status,
            direction: result.direction,
            from: result.from,
            to: result.to,
            timestamp: new Date().toISOString()
        });

        return result.sid;
    } catch (error) {
        console.error('\n=== SMS Send Error ===');
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            status: error.status,
            twilioError: error.twilioError,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        
        throw new Error(`SMS send failed: ${error.message}`);
    } finally {
        console.log('=== End SMS Attempt ===\n');
    }
}

// Enhanced webhook endpoint with detailed logging and query parameter support
app.post('/api/sms-webhook', async (req, res) => {
    console.log('\n=== Webhook Request Details ===');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));
    console.log('Query Parameters:', JSON.stringify(req.query, null, 2));
    console.log('Timestamp:', new Date().toISOString());
    console.log('===========================\n');

    try {
        // Get phone number from either body, query parameters, or recipient field
        const phoneNumber = req.body.phoneNumber || req.body.recipient || req.query.recipient || req.query.phoneNumber;
        const message = req.body.message || req.query.message;
        
        if (!phoneNumber || !message) {
            console.error('Missing parameters:', { phoneNumber, message });
            return res.status(400).json({
                success: false,
                error: 'Missing phoneNumber/recipient or message'
            });
        }
        
        try {
            const messageSid = await sendSMS(phoneNumber, message);
            
            console.log('Webhook response:', {
                success: true,
                messageSid,
                timestamp: new Date().toISOString()
            });

            res.json({
                success: true,
                messageSid,
                message: 'SMS sent successfully'
            });
        } catch (smsError) {
            console.error('Error sending SMS in webhook:', smsError);
            res.status(500).json({
                success: false,
                error: `SMS send failed: ${smsError.message}`
            });
        }
    } catch (error) {
        console.error('Error in SMS webhook:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Function to find or create contact in GHL
async function findOrCreateContact(phoneNumber) {
    try {
        // First, try to find the contact
        const searchResponse = await fetch(`${GHL_API_URL}/contacts/search?query=${phoneNumber}`, {
            headers: {
                'Authorization': `Bearer ${GHL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!searchResponse.ok) {
            throw new Error(`Failed to search contact: ${searchResponse.statusText}`);
        }

        const searchResult = await searchResponse.json();
        
        if (searchResult.contacts && searchResult.contacts.length > 0) {
            return searchResult.contacts[0];
        }

        // If contact not found, create new one
        const createResponse = await fetch(`${GHL_API_URL}/contacts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GHL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone: phoneNumber,
                locationId: GHL_LOCATION_ID
            })
        });

        if (!createResponse.ok) {
            throw new Error(`Failed to create contact: ${createResponse.statusText}`);
        }

        const newContact = await createResponse.json();
        return newContact.contact;
    } catch (error) {
        console.error('Error in findOrCreateContact:', error);
        throw error;
    }
}

// Function to add tag to contact in GHL
async function addTagToContact(contactId, tag) {
    try {
        const response = await fetch(`${GHL_API_URL}/contacts/${contactId}/tags`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GHL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                tags: [tag]
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to add tag: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Error in addTagToContact:', error);
        throw error;
    }
}

async function createUltravoxCall(clientName, phoneNumber, userType) {
    const systemPrompt = `
## Agent Role
  - Name: Claire
  - Context: Voice-based conversation
  - Current time: ${new Date().toISOString()}
  - User's name: ${clientName}
  - User Type: ${userType}
  - User's phone number: ${phoneNumber}

⸻


📣 Prompt Start (Universal)

"Hello, may I speak with ${clientName}? This is Claire, Danellas new AI Assistant, from the Visibility Event with Dannella Burnett and the Speakers Need fo Speak Team."
(If the person is not there, use the addContact tool with the following parameters:)
{
  clientName: "${clientName}",
  phoneNumber: "${phoneNumber}"
  tag: "update: events -> ve0525-confirm-call-initiated"
}

(if not there)
Politeley end the call.
⸻

🔼 If VIP – VIP Mode

"Hey ${clientName}, so glad you'll be joining us for The Visibility Event this week, . As a VIP, your event starts later today, with a special session at 4pm today Eastern time! 
Will you be joining us for that?"

(If the call goes to voicemail, use the addContact tool with the following parameters:)
{
  clientName: "${clientName}",
  phoneNumber: "${phoneNumber}"
  tag: "events -> ve0525flash-call-left-message"
}
(When leaving a voice message, do not ask them to call back, instead say we will call you again.)

(If they say they will attend, use the addContact tool with the following parameters:)
{
  clientName: "${clientName}",
  phoneNumber: "${phoneNumber}"
  tag: "update: events -> ve0525-vip-tuesday-confirm-yes"
}


(If they say they will not attend, use the addContact tool with the following parameters:)
{
  clientName: "${clientName}",
  phoneNumber: "${phoneNumber}"
  tag: "update: events -> ve0525-vip-tuesday-confirm-no"
}

(If they say they will attend)

"Awesome,
Now here are the things you need to know—
Check your email for your unique login—that's your access to the event. Checkin starts TODAY at 1pm Eastern time. 
Remember you've got your exclusive VIP session at 4pm Eastern time. Make sure you check your email for your unique link that's gonna get you access to the event and be sure 
to get there on time because Dannella starts promptly and rewards people that are there on time? 
Also, the main event begins at 11 AM. Tomorrow. Will you be joining us for that, ${clientName}?"



(if they will not attend)
"Aw, that’s a shame—So even though you can’t make it today for the special VIP session, Remember that check-in runs from 1 to 5 PM today Eastern 
time and continues tomorrow starting at 9:30 AM. The main event begins at 11 AM. Tomorrow. Will you be joining us for that, ${clientName}? "

(if they are attending tomorrow)
"Great, awesome! I am so glad you will be attending tomorrow as well."

(If they say they will attend tomorrow, use the addContact tool with the following parameters:)
{
  clientName: "${clientName}",
  phoneNumber: "${phoneNumber}"
  tag: "update: events -> ve0525-confirm-yes"
}

(If they say they will not attend tomorrow, use the addContact tool with the following parameters:)
{
  clientName: "${clientName}",
  phoneNumber: "${phoneNumber}"
  tag: "update: events -> ve0525-confirm-no"
}

"Do you have any other questions before we end the call today, ${clientName}? Okay, we hope to see you later today for your special VIP session! Also, just to reiterate, remember that check-in runs from 1 to 5 PM today 
Eastern time and continues tomorrow starting at 9:30 AM. 
Be sure to check your email for your special link to get into the event—that’s your digital ticket and it’s unique to you!"


⸻

🎉 If GA – GA Mode

"So glad you'll be joining us for The Visibility Event this week!

The full event begins tomorrow at 11:00am (Wednesday). Will you be attending?"

(If the call goes to voicemail, use the addContact tool with the following parameters:)
{
  clientName: "${clientName}",
  phoneNumber: "${phoneNumber}"
  tag: "events -> ve0525flash-call-left-message"
}


(When leaving a voice message, do not ask them to call back, instead say we will call you again.)

(If they say they will attend)

"Awesome,
Now here are the things you need to know—

Check your email for your unique login—that's your access to the event. Check-in starts TODAY at 1pm Eastern time and will go until 5pm.. 

We'll be reopening check-in at 9:30am tomorrow (Wednesday) just in case you miss it today."

(If they say they will attend, use the addContact tool with the following parameters:)
{
  clientName: "${clientName}",
  phoneNumber: "${phoneNumber}"
  tag: "update: events -> ve0525-confirm-yes"
}

(If they say they will not attend, use the addContact tool with the following parameters:)
{
  clientName: "${clientName}",
  phoneNumber: "${phoneNumber}"
  tag: "update: events -> ve0525-confirm-no"
}

"That's it for now, ${clientName}. We hope to see you later today for your special VIP session!"
Politely end the call.

`;

    // Get server base URL
    const baseUrl = getServerBaseUrl();
    
    // Define tools with proper client implementation structure
    const selectedTools = [
        {
            "temporaryTool": {
                "modelToolName": "sendSMS",
                "description": "Send an SMS message to the user with the provided content",
                "dynamicParameters": [
                    {
                        "name": "recipient",
                        "location": "PARAMETER_LOCATION_BODY",
                        "schema": {
                            "type": "string",
                            "description": "The recipient's phone number in E.164 format (e.g., +1234567890)"
                        },
                        "required": true
                    },
                    {
                        "name": "message",
                        "location": "PARAMETER_LOCATION_BODY",
                        "schema": {
                            "type": "string",
                            "description": "The text message to be sent"
                        },
                        "required": true
                    }
                ],
                "client": {
                    "implementation": async (parameters) => {
                        try {
                            console.log('SMS tool implementation called with parameters:', parameters);
                            const response = await fetch(`${baseUrl}/api/sms-webhook`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    recipient: parameters.recipient,
                                    message: parameters.message
                                })
                            });

                            if (!response.ok) {
                                const errorData = await response.text();
                                console.error('SMS webhook error:', {
                                    status: response.status,
                                    statusText: response.statusText,
                                    error: errorData
                                });
                                throw new Error('Failed to send SMS');
                            }

                            const result = await response.json();
                            console.log('SMS tool implementation success:', result);
                            return `SMS sent successfully (${result.messageSid})`;
                        } catch (error) {
                            console.error('Error in sendSMS tool:', error);
                            return 'Failed to send SMS';
                        }
                    }
                }
            }
        },
        {
      temporaryTool: {
        modelToolName: 'addContact',
        description: 'Add a contact via external CRM API',
        dynamicParameters: [
          { name: 'clientName', location: 'PARAMETER_LOCATION_QUERY', schema: { type: 'string', description: 'Name of the client' }, required: true },
          { name: 'phoneNumber', location: 'PARAMETER_LOCATION_QUERY', schema: { type: 'string', description: 'Phone number of the client' }, required: true },
          { name: 'tag', location: 'PARAMETER_LOCATION_QUERY', schema: { type: 'string', description: 'The tag to use on GHL' }, required: false }
        ],
        http: {
          baseUrlPattern: 'https://tag-ghl-danella.onrender.com/api/contacts',
          httpMethod: 'GET'
        }
      }
    }
  ];
    
    const ULTRAVOX_CALL_CONFIG = {
        systemPrompt: systemPrompt,
        model: 'fixie-ai/ultravox-70B',
        voice: 'b0e6b5c1-3100-44d5-8578-9015aa3023ae',
        temperature: 0.4,
        firstSpeaker: "FIRST_SPEAKER_USER",
        medium: { "twilio": {} },
        selectedTools: selectedTools
    };

    try {
        console.log(`Creating Ultravox call with webhook URL: ${baseUrl}/api/sms-webhook`);
        
        const response = await fetch('https://api.ultravox.ai/api/calls', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': ULTRAVOX_API_KEY
            },
            body: JSON.stringify(ULTRAVOX_CALL_CONFIG)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ultravox API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error creating Ultravox call:', error);
        throw error;
    }
}

async function initiateCall(clientName, phoneNumber, userType) {
    try {
        console.log(`Creating Ultravox call for ${clientName} (${userType}) at ${phoneNumber}...`);
        
        const ultravoxCall = await createUltravoxCall(clientName, phoneNumber, userType);
        const { joinUrl } = ultravoxCall;
        console.log('Got joinUrl:', joinUrl);

        const baseUrl = getServerBaseUrl();
        // Include clientName in the status callback URL
        const statusCallbackUrl = `${baseUrl}/call-status?clientName=${encodeURIComponent(clientName)}&phoneNumber=${encodeURIComponent(phoneNumber)}`;

        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const call = await client.calls.create({
            twiml: `<Response><Connect><Stream url="${joinUrl}"/></Connect></Response>`,
            to: phoneNumber,
            from: TWILIO_PHONE_NUMBER,
            statusCallback: statusCallbackUrl,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallbackMethod: 'POST'
        });

        console.log('Call initiated:', call.sid);
        return call.sid;
    } catch (error) {
        console.error('Error initiating call:', error);
        throw error;
    }
}

// Add call status webhook endpoint
app.post('/call-status', async (req, res) => {
    const callStatus = req.body.CallStatus;
    const callSid = req.body.CallSid;
    const to = req.body.To;
    const clientName = req.query.clientName;
    const phoneNumber = req.query.phoneNumber;

    console.log('Call Status Update:', {
        callSid,
        status: callStatus,
        to,
        clientName,
        phoneNumber,
        timestamp: new Date().toISOString()
    });

    // Handle different call statuses
    switch (callStatus) {
        case 'initiated':
            console.log(`Call ${callSid} initiated to ${to}`);
            break;
        case 'ringing':
            console.log(`Call ${callSid} is ringing`);
            break;
        case 'busy':
            console.log(`Call ${callSid} was busy`);
            try {
                const tag = encodeURIComponent('events → ve0525flash-call-busy');
                const formattedPhone = formatPhoneNumberForTagging(phoneNumber || to);
                const tagUrl = `https://tag-ghl-danella.onrender.com/api/contacts?clientName=${encodeURIComponent(clientName)}&phoneNumber=${formattedPhone}&tag=${tag}`;
                
                console.log('Tagging busy contact with URL:', tagUrl);
                
                const response = await fetch(tagUrl);
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Failed to tag contact: ${response.statusText} - ${errorText}`);
                }
                console.log(`Successfully tagged contact for busy call: ${to}`);
            } catch (error) {
                console.error('Error tagging busy contact:', error);
            }
            break;
        case 'no-answer':
            console.log(`Call ${callSid} was not answered`);
            try {
                const tag = encodeURIComponent('events → ve0525flash-call-no-answer');
                const formattedPhone = formatPhoneNumberForTagging(phoneNumber || to);
                const tagUrl = `https://tag-ghl-danella.onrender.com/api/contacts?clientName=${encodeURIComponent(clientName)}&phoneNumber=${formattedPhone}&tag=${tag}`;
                
                console.log('Tagging no-answer contact with URL:', tagUrl);
                
                const response = await fetch(tagUrl);
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Failed to tag contact: ${response.statusText} - ${errorText}`);
                }
                console.log(`Successfully tagged contact for no-answer call: ${to}`);
            } catch (error) {
                console.error('Error tagging no-answer contact:', error);
            }
            break;
        case 'failed':
        case 'canceled':
            console.log(`Call ${callSid} was not completed (${callStatus})`);
            break;
        case 'completed':
            console.log(`Call ${callSid} completed`);
            break;
    }

    res.sendStatus(200);
});

// New endpoint to send SMS directly
app.post('/send-sms', async (req, res) => {
    console.log('Received direct SMS request:', {
        body: req.body,
        headers: req.headers
    });

    try {
        const { phoneNumber, message } = req.body;
        
        if (!phoneNumber || !message) {
            console.error('Missing parameters in direct SMS:', { phoneNumber, message });
            return res.status(400).json({ 
                error: 'Missing required parameters: phoneNumber and message' 
            });
        }

        const messageSid = await sendSMS(phoneNumber, message);
        res.json({ 
            success: true, 
            message: 'SMS sent successfully',
            messageSid 
        });
    } catch (error) {
        console.error('Error in direct SMS endpoint:', error);
        res.status(500).json({ 
            error: 'Failed to send SMS',
            message: error.message 
        });
    }
});

// Add basic health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Handle both GET and POST requests
app.route('/initiate-call')
    .get(handleCall)
    .post(handleCall);

async function handleCall(req, res) {
    try {
        const clientName = req.query.clientName || req.body.clientName;
        const phoneNumber = req.query.phoneNumber || req.body.phoneNumber;
        const userType = req.query.userType || req.body.userType || 'non-VIP';
        
        if (!clientName || !phoneNumber) {
            return res.status(400).json({ 
                error: 'Missing required parameters: clientName and phoneNumber' 
            });
        }

        // Format and validate phone number
        const formattedNumber = formatPhoneNumber(phoneNumber);
        if (!formattedNumber) {
            return res.status(400).json({
                error: 'Invalid phone number format. Please provide a valid phone number (e.g., 1234567890 or +1234567890)'
            });
        }

        const callSid = await initiateCall(clientName, formattedNumber, userType);
        res.json({ 
            success: true, 
            message: 'Call initiated successfully',
            callSid 
        });
    } catch (error) {
        console.error('Error in handleCall:', error);
        res.status(500).json({ 
            error: 'Failed to initiate call',
            message: error.message 
        });
    }
}

const PORT = process.env.PORT || 10000;

// Wrap server startup in a try-catch block
try {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
} catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
}
