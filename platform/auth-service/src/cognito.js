// ---------------------------------------------------------------
// The Cognito calls the auth service makes. auth-role may only run the
// Admin* actions on our own user pool (see infra/iam/auth-policy.json).
// ---------------------------------------------------------------
const {
    CognitoIdentityProviderClient, SignUpCommand, AdminConfirmSignUpCommand,
    AdminAddUserToGroupCommand, InitiateAuthCommand, GlobalSignOutCommand
} = require('@aws-sdk/client-cognito-identity-provider');

function createCognito({
    userPoolId = process.env.COGNITO_USER_POOL_ID,
    clientId = process.env.COGNITO_CLIENT_ID,
    client
} = {}) {
    if (!userPoolId || !clientId) throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set.');
    const idp = client || new CognitoIdentityProviderClient({});

    return {
        // New users are always in the "user" group. Only an admin can make admins (in the console).
        async signUp(email, password) {
            const out = await idp.send(new SignUpCommand({
                ClientId: clientId, Username: email, Password: password,
                UserAttributes: [{ Name: 'email', Value: email }]
            }));
            // No email sending in this project, so the account is confirmed here
            await idp.send(new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: email }));
            await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: 'user' }));
            return out.UserSub;
        },
        async logIn(email, password) {
            const out = await idp.send(new InitiateAuthCommand({
                ClientId: clientId, AuthFlow: 'USER_PASSWORD_AUTH',
                AuthParameters: { USERNAME: email, PASSWORD: password }
            }));
            return out.AuthenticationResult;   // AccessToken, IdToken, RefreshToken, ExpiresIn
        },
        async logOut(accessToken) {
            await idp.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
        }
    };
}

module.exports = { createCognito };
