const SibApiV3Sdk = require('sib-api-v3-sdk');

const client = SibApiV3Sdk.ApiClient.instance;
client.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

async function sendEmail(to, subject, htmlContent) {
  await tranEmailApi.sendTransacEmail({
    sender: {
      email: process.env.BREVO_SENDER_EMAIL,
      name: process.env.BREVO_SENDER_NAME || 'Real Estate BD',
    },
    to: [{ email: to }],
    subject,
    htmlContent,
  });
}

async function sendVerificationEmail(to, code) {
  await sendEmail(
    to,
    'Verify your Real Estate BD account',
    `<p>Your verification code is <b style="font-size:20px">${code}</b>.</p>
     <p>It expires in 10 minutes. If you did not sign up, ignore this email.</p>`
  );
}

module.exports = { sendVerificationEmail };
