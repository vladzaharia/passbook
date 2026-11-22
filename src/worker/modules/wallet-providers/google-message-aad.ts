/** The AAD of a change message's envelope (wallet_google_messages, 0197); the KEK re-wrap uses it too. */
export const googleMessageAad = (instanceId: string, id: string): string =>
  `wallet-google-message-v1|${instanceId}|${id}`;
