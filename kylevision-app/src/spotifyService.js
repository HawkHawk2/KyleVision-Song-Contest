// src/spotifyService.js

// Dynamic URL works both in local testing and when live on Vercel
const API_BASE = window.location.hostname === 'localhost' 
  ? 'http://localhost:3000/api/get-token' 
  : '/api/get-token';

async function getSpotifyToken() {
  const response = await fetch(API_BASE);
  const data = await response.json();
  return data.access_token;
}

export async function searchSpotify(query) {
  try {
    const token = await getSpotifyToken();
    const formattedQuery = encodeURIComponent(query);
    
    const response = await fetch(`https://spotify.com{formattedQuery}&type=track&limit=5`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const data = await response.json();
    return data.tracks.items; // Returns the top 5 tracks
  } catch (error) {
    console.error("Spotify API Search Error:", error);
    return [];
  }
}
