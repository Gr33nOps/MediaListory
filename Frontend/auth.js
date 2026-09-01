const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '/api';

let pendingEmail = '';
let _authConfigPromise = null;

document.addEventListener('DOMContentLoaded', async function() {
    initializeAuthUI();
    const oauthDone = await handleOAuthReturn();
    if (oauthDone) return;
    await checkExistingSession();
    await handleUrlParams();
});

// Server tells us which social providers are enabled.
async function getAuthConfig() {
    if (!_authConfigPromise) {
        _authConfigPromise = (async function() {
            try {
                var res = await fetch(API_BASE + '/auth/public-config');
                var cfg = await res.json();
                return { providers: cfg.providers || [] };
            } catch (_) {
                return { providers: [] };
            }
        })();
    }
    return _authConfigPromise;
}

function setOAuthSectionVisible(visible) {
    var section = document.getElementById('oauthSection');
    if (section) section.style.display = visible ? '' : 'none';
}

function showOAuthWorking() {
    hideAllViews();
    setOAuthSectionVisible(false);
    document.getElementById('authTabs').style.display = 'none';
    var status = document.getElementById('oauthStatus');
    if (status) status.classList.remove('hidden');
}

function showOAuthError(message) {
    hideAllViews();
    switchTab('login');
    setOAuthSectionVisible(true);
    var el = document.getElementById('oauthError');
    if (el) {
        el.textContent = message || 'Social sign-in failed';
        el.classList.remove('hidden');
    }
}

// Hide OAuth buttons for providers the server has not enabled (e.g. Discord).
async function syncOAuthButtons() {
    try {
        var cfg = await getAuthConfig();
        var map = { google: 'oauthGoogleBtn', github: 'oauthGithubBtn' };
        Object.keys(map).forEach(function (p) {
            var btn = document.getElementById(map[p]);
            if (btn && cfg.providers.indexOf(p) === -1) btn.style.display = 'none';
        });
        if (!cfg.providers.length) setOAuthSectionVisible(false);
    } catch (_) {}
}

async function startOAuth(provider) {
    var errEl = document.getElementById('oauthError');
    if (errEl) {
        errEl.classList.add('hidden');
        errEl.textContent = '';
    }
    var remember = document.getElementById('rememberMe');
    var rememberVal = (!remember || remember.checked) ? '1' : '0';
    var nextParam = new URLSearchParams(window.location.search).get('next');
    if (nextParam) sessionStorage.setItem('oauthNext', nextParam);
    else sessionStorage.removeItem('oauthNext');
    // Same-origin OAuth: hand off to our own server, which owns the provider callback.
    window.location.href = API_BASE + '/auth/oauth/' + encodeURIComponent(provider) + '/start?remember=' + rememberVal;
}

async function handleOAuthReturn() {
    var urlParams = new URLSearchParams(window.location.search);
    var type = urlParams.get('type');

    // Email verify / recovery use similar query params - leave those to handleUrlParams.
    if (type === 'signup' || type === 'email' || type === 'recovery') return false;

    var oauthErr = urlParams.get('oauth_error');
    if (oauthErr) {
        showOAuthError(decodeURIComponent(oauthErr));
        window.history.replaceState({}, document.title, '/auth.html');
        return true;
    }
    if (urlParams.get('oauth') !== 'done') return false;

    showOAuthWorking();
    try {
        // Our server already set the httpOnly session cookie; hydrate from it (same-origin).
        var restored = null;
        if (typeof ensureSession === 'function') restored = await ensureSession();
        if (!restored || !restored.token) {
            var r = await fetch(API_BASE + '/auth/session', { credentials: 'same-origin', cache: 'no-store' });
            if (r.ok) restored = await r.json();
        }
        if (!restored || !restored.token) throw new Error('Sign-in could not be completed. Please try again.');

        localStorage.setItem('authToken', restored.token);
        if (restored.user) localStorage.setItem('currentUser', JSON.stringify(restored.user));
        localStorage.setItem('lastActivity', Date.now().toString());
        window.history.replaceState({}, document.title, '/auth.html');

        finishOAuthLogin();
        return true;
    } catch (e) {
        showOAuthError((e && e.message) || 'Social sign-in failed');
        window.history.replaceState({}, document.title, '/auth.html');
        return true;
    }
}

async function handleUrlParams() {
    const urlParams  = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.substring(1));

    const code             = urlParams.get('code')             || hashParams.get('code');
    const tokenHash        = urlParams.get('token_hash')       || hashParams.get('token_hash');
    const resetToken       = urlParams.get('token')            || hashParams.get('token');
    const type             = urlParams.get('type')             || hashParams.get('type');
    const error            = urlParams.get('error')            || hashParams.get('error');
    const errorDescription = urlParams.get('error_description')|| hashParams.get('error_description');

    if (error) {
        showVerificationError(errorDescription || error);
        return;
    }

    if (type === 'signup' || type === 'email') {
        const verificationToken = tokenHash || code;
        if (verificationToken) {
            await handleEmailVerification(verificationToken);
        }
    } else if ((type === 'recovery' && (resetToken || code)) || resetToken) {
        // Neon Auth (Better Auth) password-reset links carry ?token=...
        window._resetCode = resetToken || code;
        showNewPasswordForm();
    }
}

async function handleEmailVerification(token) {
    hideAllViews();
    document.getElementById('authTabs').style.display = 'none';
    document.getElementById('verificationStatus').classList.remove('hidden');

    try {
        const response = await fetch(`${API_BASE}/auth/verify-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token_hash: token, code: token })
        });

        const data = await response.json();

        if (response.ok) {
            showVerificationSuccess();
            setTimeout(function() {
                window.history.replaceState({}, document.title, '/auth.html');
            }, 2000);
        } else {
            showVerificationError(data.error || 'Verification failed');
        }
    } catch (error) {
        showVerificationError('Network error during verification. Please try again.');
    }
}

function showVerificationError(message) {
    hideAllViews();
    setOAuthSectionVisible(false);
    document.getElementById('authTabs').style.display = 'none';
    document.getElementById('verificationErrorMessage').textContent = message;
    document.getElementById('verificationError').classList.remove('hidden');
    document.getElementById('authSubtitle').textContent = 'Verification Failed';
}

async function checkExistingSession() {
    try {
        if (typeof ensureSession === 'function') {
            var restored = await ensureSession();
            if (restored && restored.token) {
                if (typeof redirectAfterLogin === 'function') redirectAfterLogin('home.html');
                else window.location.href = 'home.html';
                return;
            }
        }
        var token = localStorage.getItem('authToken');
        if (!token) return;
        var response = await fetch(API_BASE + '/auth/verify', {
            headers: { 'Authorization': 'Bearer ' + token },
            credentials: 'include',
            cache: 'no-store'
        });
        if (response.ok) {
            if (typeof redirectAfterLogin === 'function') redirectAfterLogin('home.html');
            else window.location.href = 'home.html';
        } else {
            clearSession();
        }
    } catch (error) {
        /* stay on auth page if offline */
    }
}

function clearSession() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('lastActivity');
}

function initializeAuthUI() {
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            switchTab(btn.dataset.tab);
        });
    });

    document.querySelectorAll('.password-toggle').forEach(function(btn) {
        btn.addEventListener('click', function() {
            togglePasswordVisibility(btn.dataset.target);
        });
    });

    var regPassword = document.getElementById('regPassword');
    if (regPassword) {
        regPassword.addEventListener('input', function(e) {
            checkPasswordStrength(e.target.value, 'strengthFill', 'strengthText');
        });
    }

    var newPassword = document.getElementById('newPassword');
    if (newPassword) {
        newPassword.addEventListener('input', function(e) {
            checkPasswordStrength(e.target.value, 'newPasswordStrengthFill', 'newPasswordStrengthText');
        });
    }

    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('registerForm').addEventListener('submit', handleRegister);
    document.getElementById('resetPasswordForm').addEventListener('submit', handlePasswordReset);
    document.getElementById('newPasswordForm').addEventListener('submit', handleNewPassword);

    document.getElementById('forgotPasswordLink').addEventListener('click', function(e) {
        e.preventDefault();
        showResetPasswordForm();
    });

    document.getElementById('backToLogin').addEventListener('click', showLogin);

    var resendVerification = document.getElementById('resendVerification');
    if (resendVerification) resendVerification.addEventListener('click', resendVerificationEmail);

    var resendFromError = document.getElementById('resendFromError');
    if (resendFromError) resendFromError.addEventListener('click', resendVerificationEmail);

    var changeEmail = document.getElementById('changeEmail');
    if (changeEmail) {
        changeEmail.addEventListener('click', function() {
            hideAllViews();
            switchTab('register');
        });
    }

    document.getElementById('regUsername').addEventListener('blur', validateUsername);
    document.getElementById('regEmail').addEventListener('blur', validateEmail);
    document.getElementById('regConfirmPassword').addEventListener('input', validatePasswordMatch);

    var confirmNewPassword = document.getElementById('confirmNewPassword');
    if (confirmNewPassword) {
        confirmNewPassword.addEventListener('input', function() {
            validatePasswordMatch('newPassword', 'confirmNewPassword');
        });
    }

    var googleBtn = document.getElementById('oauthGoogleBtn');
    var githubBtn = document.getElementById('oauthGithubBtn');
    if (googleBtn) googleBtn.addEventListener('click', function() { startOAuth('google'); });
    if (githubBtn) githubBtn.addEventListener('click', function() { startOAuth('github'); });
    syncOAuthButtons();

    var oauthUsernameForm = document.getElementById('oauthUsernameForm');
    if (oauthUsernameForm) oauthUsernameForm.addEventListener('submit', handleOAuthUsernameSubmit);
    var oauthUsernameSkip = document.getElementById('oauthUsernameSkip');
    if (oauthUsernameSkip) {
        oauthUsernameSkip.addEventListener('click', function() {
            finishOAuthLogin();
        });
    }

    document.querySelectorAll('[data-action="show-login"]').forEach(function (btn) {
        btn.addEventListener('click', showLogin);
    });

    document.querySelectorAll('.password-toggle').forEach(function (btn) {
        if (!btn.getAttribute('aria-label')) {
            btn.setAttribute('aria-label', 'Show password');
            btn.setAttribute('aria-pressed', 'false');
        }
        var target = btn.getAttribute('data-target');
        if (target) btn.setAttribute('aria-controls', target);
    });
}

function showOAuthUsernamePicker(suggested) {
    hideAllViews();
    setOAuthSectionVisible(false);
    document.getElementById('authTabs').style.display = 'none';
    var form = document.getElementById('oauthUsernameForm');
    if (!form) {
        finishOAuthLogin();
        return;
    }
    form.classList.add('active');
    form.hidden = false;
    form.classList.remove('hidden');
    var input = document.getElementById('oauthUsernameInput');
    if (input) {
        input.value = suggested || '';
        input.focus();
    }
}

async function handleOAuthUsernameSubmit(e) {
    e.preventDefault();
    var errEl = document.getElementById('oauthUsernameError');
    if (errEl) {
        errEl.classList.add('hidden');
        errEl.textContent = '';
    }
    var input = document.getElementById('oauthUsernameInput');
    var username = input ? input.value.trim() : '';
    var btn = document.getElementById('oauthUsernameBtn');
    if (!/^[a-zA-Z0-9_]{3,50}$/.test(username)) {
        if (errEl) {
            errEl.textContent = 'Username must be 3-50 characters (letters, numbers, underscores).';
            errEl.classList.remove('hidden');
        }
        return;
    }
    if (btn) setButtonLoading(btn, true);
    try {
        var response = await fetch(API_BASE + '/auth/username', {
            method: 'PUT',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (localStorage.getItem('authToken') || '')
            },
            body: JSON.stringify({ username: username })
        });
        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not save username');
        if (data.user) localStorage.setItem('currentUser', JSON.stringify(data.user));
        finishOAuthLogin();
    } catch (err) {
        if (errEl) {
            errEl.textContent = (err && err.message) || 'Could not save username';
            errEl.classList.remove('hidden');
        }
        if (btn) setButtonLoading(btn, false);
    }
}

function finishOAuthLogin() {
    var next = sessionStorage.getItem('oauthNext') || '';
    sessionStorage.removeItem('oauthNext');
    if (typeof redirectAfterLogin === 'function') redirectAfterLogin('home.html', next);
    else if (typeof safeNextUrl === 'function') window.location.href = safeNextUrl('home.html', next);
    else window.location.href = 'home.html';
}

function hideAllViews() {
    document.querySelectorAll('.auth-form').forEach(function(el) {
        el.classList.remove('active');
        el.hidden = true;
    });

    var panelIds = [
        'verificationPending',
        'verificationStatus',
        'verificationSuccess',
        'verificationError',
        'successPanel',
        'oauthStatus',
        'oauthUsernameForm'
    ];
    panelIds.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });

    document.getElementById('authTabs').style.display = 'flex';
    setOAuthSectionVisible(true);
}

function switchTab(tab) {
    hideAllViews();
    clearAllErrors();

    var tabs = document.querySelectorAll('.tab-btn[role="tab"]');
    tabs.forEach(function(t) {
        var selected = t.dataset.tab === tab;
        t.classList.toggle('active', selected);
        t.setAttribute('aria-selected', selected ? 'true' : 'false');
        t.tabIndex = selected ? 0 : -1;
    });

    var loginForm = document.getElementById('loginForm');
    var registerForm = document.getElementById('registerForm');

    if (tab === 'login') {
        loginForm.classList.remove('hidden');
        loginForm.classList.add('active');
        loginForm.hidden = false;
        registerForm.classList.remove('active');
        registerForm.hidden = true;
        clearForm('loginForm');
        if (typeof announce === 'function') announce('Login form');
    } else if (tab === 'register') {
        registerForm.classList.remove('hidden');
        registerForm.classList.add('active');
        registerForm.hidden = false;
        loginForm.classList.remove('active');
        loginForm.hidden = true;
        clearForm('registerForm');
        if (typeof announce === 'function') announce('Registration form');
    }
}

function showLogin() {
    hideAllViews();
    switchTab('login');
    document.getElementById('authSubtitle').textContent = 'Track and discover games, movies, and series';
}

function showResetPasswordForm() {
    hideAllViews();
    setOAuthSectionVisible(false);
    document.getElementById('authTabs').style.display = 'none';
    var form = document.getElementById('resetPasswordForm');
    form.classList.remove('hidden');
    form.classList.add('active');
    form.hidden = false;
    document.getElementById('authSubtitle').textContent = 'Reset Your Password';
}

function showNewPasswordForm() {
    hideAllViews();
    setOAuthSectionVisible(false);
    document.getElementById('authTabs').style.display = 'none';
    var form = document.getElementById('newPasswordForm');
    form.classList.remove('hidden');
    form.classList.add('active');
    form.hidden = false;
    document.getElementById('authSubtitle').textContent = 'Create New Password';
}

function showVerificationPending(email) {
    hideAllViews();
    setOAuthSectionVisible(false);
    pendingEmail = email;
    document.getElementById('authTabs').style.display = 'none';
    document.getElementById('verificationEmail').textContent = email;
    document.getElementById('verificationPending').classList.remove('hidden');
    document.getElementById('authSubtitle').textContent = 'Email Verification';
}

function showVerificationSuccess() {
    hideAllViews();
    setOAuthSectionVisible(false);
    document.getElementById('authTabs').style.display = 'none';
    document.getElementById('verificationSuccess').classList.remove('hidden');
    document.getElementById('authSubtitle').textContent = 'Email Verified';
}

async function handleLogin(e) {
    e.preventDefault();

    const emailOrUsername = document.getElementById('loginEmail').value.trim();
    const password        = document.getElementById('loginPassword').value;
    const rememberMe      = document.getElementById('rememberMe').checked;
    const errorDiv        = document.getElementById('loginError');
    const successDiv      = document.getElementById('loginSuccess');
    const btn             = document.getElementById('loginBtn');

    clearError(errorDiv);
    clearError(successDiv);
    setButtonLoading(btn, true);

    if (!emailOrUsername || !password) {
        showError(errorDiv, 'Please enter both email/username and password.');
        setButtonLoading(btn, false);
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emailOrUsername: emailOrUsername, password: password, rememberMe: rememberMe })
        });

        const data = await response.json();

        if (response.ok) {
            localStorage.setItem('authToken', data.token);
            localStorage.setItem('currentUser', JSON.stringify(data.user));
            localStorage.setItem('lastActivity', Date.now().toString());

            showSuccess(successDiv, 'Login successful! Redirecting...');

            setTimeout(function() {
                if (typeof redirectAfterLogin === 'function') redirectAfterLogin('home.html');
                else window.location.href = 'home.html';
            }, 500);
        } else {
            if (data.emailNotVerified && data.email) {
                pendingEmail = data.email;
                showError(errorDiv, data.error + ' Would you like to resend the verification email?');

                const resendBtn       = document.createElement('button');
                resendBtn.textContent = 'Resend Verification Email';
                resendBtn.className   = 'btn btn-secondary';
                resendBtn.style.marginTop = '10px';
                resendBtn.style.width     = '100%';
                resendBtn.onclick = async function(e) {
                    e.preventDefault();
                    await resendVerificationEmail();
                };
                errorDiv.appendChild(resendBtn);
            } else {
                showError(errorDiv, data.error || 'Login failed. Please try again.');
            }
            setButtonLoading(btn, false);
        }
    } catch (error) {
        showError(errorDiv, 'Network error. Please check server is running and try again.');
        setButtonLoading(btn, false);
    }
}

async function handleRegister(e) {
    e.preventDefault();

    const email           = document.getElementById('regEmail').value.trim();
    const username        = document.getElementById('regUsername').value.trim();
    const displayName     = document.getElementById('regDisplayName').value.trim();
    const password        = document.getElementById('regPassword').value;
    const confirmPassword = document.getElementById('regConfirmPassword').value;
    const agreeTerms      = document.getElementById('agreeTerms').checked;
    const errorDiv        = document.getElementById('registerError');
    const btn             = document.getElementById('registerBtn');

    clearError(errorDiv);
    setButtonLoading(btn, true);

    const validation = validateRegistration(email, username, displayName, password, confirmPassword, agreeTerms);

    if (!validation.valid) {
        showError(errorDiv, validation.error);
        setButtonLoading(btn, false);
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, email: email, display_name: displayName, password: password })
        });

        const data = await response.json();

        if (response.ok && data.token) {
            // Neon Auth doesn't require email verification, so we're signed in immediately.
            localStorage.setItem('authToken', data.token);
            localStorage.setItem('currentUser', JSON.stringify(data.user));
            localStorage.setItem('lastActivity', Date.now().toString());
            if (typeof redirectAfterLogin === 'function') redirectAfterLogin('home.html');
            else window.location.href = 'home.html';
            return;
        } else if (response.ok) {
            showVerificationPending(email);
        } else {
            showError(errorDiv, data.error || 'Registration failed. Please try again.');
        }

        setButtonLoading(btn, false);
    } catch (error) {
        showError(errorDiv, 'Network error. Please check server is running and try again.');
        setButtonLoading(btn, false);
    }
}

async function resendVerificationEmail() {
    const btn          = event && event.target ? event.target : document.getElementById('resendVerification');
    const originalText = btn.textContent;

    if (!pendingEmail) {
        if (typeof notify === 'function') notify('No email found. Please try registering again.', 'error');
        return;
    }

    btn.disabled    = true;
    btn.textContent = 'Sending...';

    try {
        const response = await fetch(`${API_BASE}/auth/resend-verification`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: pendingEmail })
        });

        const data = await response.json();

        if (response.ok) {
            if (typeof notify === 'function') notify('Verification email sent! Check your inbox and spam folder.', 'success');
        } else {
            if (typeof notify === 'function') notify(data.error || 'Failed to resend email.', 'error');
        }
    } catch (error) {
        if (typeof notify === 'function') notify('Network error. Please try again.', 'error');
    } finally {
        btn.disabled    = false;
        btn.textContent = originalText;
    }
}

async function handlePasswordReset(e) {
    e.preventDefault();

    const email      = document.getElementById('resetEmail').value.trim();
    const errorDiv   = document.getElementById('resetError');
    const successDiv = document.getElementById('resetSuccess');
    const btn        = document.getElementById('resetBtn');

    clearError(errorDiv);
    clearError(successDiv);
    setButtonLoading(btn, true);

    if (!isValidEmail(email)) {
        showError(errorDiv, 'Please enter a valid email address.');
        setButtonLoading(btn, false);
        return;
    }

    try {
        await fetch(`${API_BASE}/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email })
        });

        showSuccess(successDiv, 'If a matching account exists, a reset link has been sent.');
        document.getElementById('resetEmail').value = '';
        setButtonLoading(btn, false);
    } catch (error) {
        showError(errorDiv, 'Network error. Please try again.');
        setButtonLoading(btn, false);
    }
}

async function handleNewPassword(e) {
    e.preventDefault();

    const newPassword     = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmNewPassword').value;
    const errorDiv        = document.getElementById('newPasswordError');
    const btn             = document.getElementById('newPasswordBtn');

    clearError(errorDiv);

    if (newPassword !== confirmPassword) {
        showError(errorDiv, 'Passwords do not match.');
        return;
    }

    if (newPassword.length < 8) {
        showError(errorDiv, 'Password must be at least 8 characters.');
        return;
    }

    if (!window._resetCode) {
        showError(errorDiv, 'Invalid or expired reset link. Please request a new one.');
        return;
    }

    setButtonLoading(btn, true);

    try {
        const response = await fetch(`${API_BASE}/auth/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: window._resetCode, code: window._resetCode, password: newPassword })
        });

        const data = await response.json();

        if (response.ok) {
            window._resetCode = null;
            hideAllViews();
            document.getElementById('authTabs').style.display = 'none';
            document.getElementById('successPanel').classList.remove('hidden');
        } else {
            showError(errorDiv, data.error || 'Password reset failed.');
            setButtonLoading(btn, false);
        }
    } catch (error) {
        showError(errorDiv, 'Network error. Please try again.');
        setButtonLoading(btn, false);
    }
}

function validateRegistration(email, username, displayName, password, confirmPassword, agreeTerms) {
    if (!email || !username || !displayName || !password || !confirmPassword) {
        return { valid: false, error: 'All fields are required.' };
    }
    if (!isValidEmail(email)) {
        return { valid: false, error: 'Please enter a valid email address.' };
    }
    if (!isValidUsername(username)) {
        return { valid: false, error: 'Username must be 3-50 characters and contain only letters, numbers, and underscores.' };
    }
    if (displayName.length < 2 || displayName.length > 100) {
        return { valid: false, error: 'Display name must be between 2 and 100 characters.' };
    }
    if (password.length < 8) {
        return { valid: false, error: 'Password must be at least 8 characters long.' };
    }
    if (password !== confirmPassword) {
        return { valid: false, error: 'Passwords do not match.' };
    }
    if (getPasswordStrength(password) < 2) {
        return { valid: false, error: 'Password is too weak. Please use a stronger password.' };
    }
    if (!agreeTerms) {
        return { valid: false, error: 'You must agree to the Terms of Service and Privacy Policy.' };
    }
    return { valid: true };
}

function isValidEmail(email) {
    var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function isValidUsername(username) {
    var usernameRegex = /^[a-zA-Z0-9_]{3,50}$/;
    return usernameRegex.test(username);
}

async function validateUsername() {
    const input    = document.getElementById('regUsername');
    const username = input.value.trim();

    if (username.length < 3) return;

    if (!isValidUsername(username)) {
        input.setCustomValidity('Username must be 3-50 characters (letters, numbers, underscores only)');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/auth/check-username/${username}`);
        const data     = await response.json();
        input.setCustomValidity(data.exists ? 'Username already taken' : '');
    } catch (error) {
        input.setCustomValidity('');
    }
}

function validateEmail() {
    const input = document.getElementById('regEmail');
    const email = input.value.trim();
    input.setCustomValidity(isValidEmail(email) ? '' : 'Please enter a valid email address');
}

function validatePasswordMatch(passwordId, confirmId) {
    var pid = passwordId || 'regPassword';
    var cid = confirmId  || 'regConfirmPassword';

    const password        = document.getElementById(pid).value;
    const confirmPassword = document.getElementById(cid);

    if (confirmPassword.value && password !== confirmPassword.value) {
        confirmPassword.setCustomValidity('Passwords do not match');
    } else {
        confirmPassword.setCustomValidity('');
    }
}

function checkPasswordStrength(password, fillId, textId) {
    const strength     = getPasswordStrength(password);
    const strengthFill = document.getElementById(fillId);
    const strengthText = document.getElementById(textId);

    const levels = ['Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
    const colors = ['#ff4444', '#ff8800', '#ffbb00', '#88cc00', '#00cc44'];
    const widths = ['20%', '40%', '60%', '80%', '100%'];

    strengthFill.style.width           = widths[strength];
    strengthFill.style.backgroundColor = colors[strength];
    strengthText.textContent           = 'Password strength: ' + levels[strength];
}

function getPasswordStrength(password) {
    var strength = 0;
    if (password.length >= 8)  strength++;
    if (password.length >= 12) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/\d/.test(password))   strength++;
    if (/[^a-zA-Z0-9]/.test(password)) strength++;
    return Math.min(strength, 4);
}

function togglePasswordVisibility(inputId) {
    const input  = document.getElementById(inputId);
    const button = document.querySelector('[data-target="' + inputId + '"]');
    if (!input || !button) return;

    if (input.type === 'password') {
        input.type = 'text';
        button.textContent = 'Hide';
        button.setAttribute('aria-label', 'Hide password');
        button.setAttribute('aria-pressed', 'true');
    } else {
        input.type = 'password';
        button.textContent = 'Show';
        button.setAttribute('aria-label', 'Show password');
        button.setAttribute('aria-pressed', 'false');
    }
}

function setButtonLoading(button, loading) {
    const text   = button.querySelector('.btn-text');
    const loader = button.querySelector('.btn-loader');

    if (loading) {
        text.classList.add('hidden');
        loader.classList.remove('hidden');
        button.disabled = true;
    } else {
        text.classList.remove('hidden');
        loader.classList.add('hidden');
        button.disabled = false;
    }
}

function showError(element, message) {
    element.textContent = message;
    element.classList.remove('hidden');
    element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showSuccess(element, message) {
    element.textContent = message;
    element.classList.remove('hidden');
    element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearError(element) {
    element.textContent = '';
    element.classList.add('hidden');
    while (element.lastChild && element.lastChild.nodeName === 'BUTTON') {
        element.removeChild(element.lastChild);
    }
}

function clearAllErrors() {
    document.querySelectorAll('.error, .success').forEach(function(el) {
        clearError(el);
    });
}

function clearForm(formId) {
    document.getElementById(formId).reset();
    clearAllErrors();
}

window.authApp = {
    showLogin: showLogin,
    showResetPasswordForm: showResetPasswordForm,
    showVerificationPending: showVerificationPending
};