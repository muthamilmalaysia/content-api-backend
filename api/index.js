// api/index.js
import express from 'express';
import { kv } from '@vercel/kv';
import axios from 'axios';
import cors from 'cors'; // 1. IMPORT CORS

// Initialize Express app
const app = express();

// 2. USE THE CORS MIDDLEWARE
// This must be placed before your route definitions.
app.use(cors({
  origin: process.env.FRONTEND_URL 
}));

app.use(express.json());

// ... the rest of your API code remains the same ...
import express from 'express';
import { kv } from '@vercel/kv';
import axios from 'axios';

// Initialize Express app
const app = express();
app.use(express.json());

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GOOGLE_AI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GOOGLE_AI_API_KEY}`;

// A list of the 13 specific political branches
const POLITICAL_BRANCHES = [
    "CABANG – KEPONG", "CABANG – BATU", "CABANG – WANGSA MAJU", "CABANG – SEGAMBUT",
    "CABANG – SETIAWANGSA", "CABANG – TITIWANGSA", "CABANG – BUKIT BINTANG",
    "CABANG – LEMBAH PANTAI", "CABANG – SEPUTEH", "CABANG – CHERAS",
    "CABANG – BANDAR TUN RAZAK", "CABANG – PUTRAJAYA", "CABANG - LABUAN"
];

/**
 * -----------------------------------------------------------------------------
 * API Endpoint: POST /api/generate
 * -----------------------------------------------------------------------------
 * This endpoint generates social media content based on a URL and political stance.
 */
app.post('/api/generate', async (req, res) => {
    try {
        const { url, stance } = req.body;

        // 1. Input Validation
        if (!url || !stance || !['PRO', 'ANTI'].includes(stance.toUpperCase())) {
            return res.status(400).json({ error: 'Invalid input. "url" and "stance" (PRO/ANTI) are required.' });
        }

        // 2. Construct the master prompt for the Google AI API
        const stanceInstruction = stance.toUpperCase() === 'PRO'
            ? "Create professional, supportive content about the current government and Datuk Seri Anwar Ibrahim, maintaining a formal and respectful tone in Malay."
            : "Create aggressive but factual critical content in formal Malay against the Perikatan Nasional opposition. Focus only on documented ethical or legal issues from reliable sources. Do not use inflammatory language. Be assertive and direct.";
        
        const masterPrompt = `
            Based on the news article found at this URL: ${url}

            Your task is to generate 13 unique social media content pairs (one Facebook post, one Tweet) for 13 different political branches.

            Stance guideline: ${stanceInstruction}

            For each of the following 13 branches, generate a unique content pair tailored to a general audience in that area: ${POLITICAL_BRANCHES.join(', ')}.

            The output MUST be a single, minified JSON object. Do not include any text before or after the JSON object. The JSON object must have a single key "contentPairs" which is an array of 13 objects. Each object in the array must have three keys: "branch", "facebookPost", and "tweet".

            Example of a single element in the array:
            {"branch":"CABANG – KEPONG","facebookPost":"<Generated Facebook post in formal Malay>","tweet":"<Generated Tweet in formal Malay>"}
        `;

        // 3. Call the Google AI API
        const aiResponse = await axios.post(GOOGLE_AI_API_URL, {
            contents: [{ parts: [{ text: masterPrompt }] }],
        });

        // 4. Parse the AI's response
        // The AI's response is often wrapped in markdown ticks (```json ... ```) and may contain other text.
        // We need to reliably extract the JSON object.
        const responseText = aiResponse.data.candidates[0].content.parts[0].text;
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error("AI did not return valid JSON:", responseText);
            throw new Error("Failed to parse AI response. No valid JSON object found.");
        }
        const parsedContent = JSON.parse(jsonMatch[0]);

        if (!parsedContent.contentPairs || parsedContent.contentPairs.length !== 13) {
             throw new Error("AI response did not match the required format (13 content pairs).");
        }

        // 5. Prepare and save data to Vercel KV
        const jobId = `gen_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const jobData = {
            id: jobId,
            createdAt: new Date().toISOString(),
            sourceUrl: url,
            stance: stance.toUpperCase(),
            contentPairs: parsedContent.contentPairs,
        };

        // Use a transaction to ensure atomicity
        const tx = kv.multi();
        tx.set(jobId, jobData); // Store the full job object
        tx.set('latest_content_id', jobId); // Update the pointer to the latest job
        tx.zadd('jobs_by_date', { score: Date.now(), member: jobId }); // Add to sorted set for history
        await tx.exec();

        // 6. Return success response
        return res.status(201).json({ message: 'Content generated successfully.', jobId: jobId });

    } catch (error) {
        console.error('Error in /api/generate:', error.response ? error.response.data : error.message);
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


/**
 * -----------------------------------------------------------------------------
 * API Endpoint: GET /api/history
 * -----------------------------------------------------------------------------
 * Retrieves a list of all previously generated content jobs.
 */
app.get('/api/history', async (req, res) => {
    try {
        // Fetch all job IDs from the sorted set, newest first.
        const jobIds = await kv.zrevrange('jobs_by_date', 0, -1);
        if (!jobIds || jobIds.length === 0) {
            return res.status(200).json([]);
        }
        
        // Retrieve all job objects in a single batch call.
        const jobs = await kv.mget(...jobIds);

        return res.status(200).json(jobs);
    } catch (error) {
        console.error('Error in /api/history:', error.message);
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


/**
 * -----------------------------------------------------------------------------
 * API Endpoint: GET /api/content
 * -----------------------------------------------------------------------------
 * Retrieves the single most recent content set for the user-facing app.
 */
app.get('/api/content', async (req, res) => {
    try {
        const latestJobId = await kv.get('latest_content_id');
        
        if (!latestJobId) {
            return res.status(404).json({ error: 'No content has been generated yet.' });
        }
        
        const latestJob = await kv.get(latestJobId);

        return res.status(200).json(latestJob);
    } catch (error) {
        console.error('Error in /api/content:', error.message);
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// Export the app
export default app;
