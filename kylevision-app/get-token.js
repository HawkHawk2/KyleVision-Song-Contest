import { Buffer } from 'buffer';

export default async function handler(req, res) {
  // Allow your frontend to talk to this endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // LEAVE THESE ALONE - Vercel will handle filling these in safely!
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  try {
    // ⚠️ FIXED URL: Changed from 'https://spotify.com' to the accounts token endpoint
    const tokenResponse = await fetch('https://spotify.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // This converts the hidden variables into the layout format Spotify requires
        'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
      },
      body: 'grant_type=client_credentials',
    });

    const data = await tokenResponse.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch Spotify token' });
  }
}
