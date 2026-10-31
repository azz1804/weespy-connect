"""Reuse a saved X browser session before opening its sign-in form."""

def start_login_page(driver, network, login):
    if network != 'x':
        driver.get(login)
        return
    driver.get('https://x.com/home')
    names = {cookie.get('name') for cookie in driver.get_cookies()
             if cookie.get('domain', '').lstrip('.').lower() == 'x.com' and cookie.get('value')}
    # Presence only selects the entry page. The normal engine still verifies
    # identity, cookie stability and the VPS storage receipt before success.
    if not {'auth_token', 'ct0'}.issubset(names):
        driver.get(login)
