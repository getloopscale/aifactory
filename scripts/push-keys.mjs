// Prints a new VAPID key pair for Web Push. Put the three lines in the server's environment.
import webpush from 'web-push'

const { publicKey, privateKey } = webpush.generateVAPIDKeys()
console.log(`FACTORY_PUSH_PUBLIC_KEY=${publicKey}`)
console.log(`FACTORY_PUSH_PRIVATE_KEY=${privateKey}`)
console.log("FACTORY_PANEL_ORIGIN=https://<the panel's HTTPS address>")
