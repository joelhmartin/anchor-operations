// server/services/metaGraph.js
// Slim shim: the two Facebook/Instagram resource fns metaPagePosting.js needs.
// Extracted from the main app's oauthIntegration.js to avoid porting its full
// 1400-line OAuth surface (Google/Microsoft/WordPress) we don't use here.

const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v21.0';

/** Fetch Facebook Pages the token can manage. */
export async function fetchFacebookPages(accessToken) {
  const res = await fetch(
    `${FACEBOOK_GRAPH_URL}/me/accounts?fields=id,name,access_token,category,picture,link,instagram_business_account&access_token=${accessToken}`
  );
  if (!res.ok) {
    const text = await res.text();
    console.error('[metaGraph:fetchFacebookPages] Failed:', text);
    if (res.status === 404 || res.status === 403) return [];
    throw new Error(`Failed to fetch Facebook Pages: ${text}`);
  }
  const data = await res.json();
  return (data.data || []).map((page) => ({
    id: page.id,
    name: page.name,
    category: page.category,
    picture: page.picture?.data?.url || '',
    link: page.link,
    accessToken: page.access_token,
    instagramBusinessAccountId: page.instagram_business_account?.id || null
  }));
}

/** Fetch Instagram Business Account details for a Page. */
export async function fetchInstagramAccountForPage(pageAccessToken, instagramAccountId) {
  const res = await fetch(
    `${FACEBOOK_GRAPH_URL}/${instagramAccountId}?fields=id,username,name,profile_picture_url,followers_count,media_count&access_token=${pageAccessToken}`
  );
  if (!res.ok) {
    const text = await res.text();
    console.error('[metaGraph:fetchInstagramAccountForPage] Failed:', text);
    return null;
  }
  const data = await res.json();
  return {
    id: data.id,
    username: data.username,
    name: data.name || data.username,
    picture: data.profile_picture_url || '',
    followersCount: data.followers_count,
    mediaCount: data.media_count
  };
}
