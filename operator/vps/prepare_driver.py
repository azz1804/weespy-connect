"""Download the pinned Mozilla driver and verify the digest from its release metadata."""
import hashlib, io, json, pathlib, tarfile, urllib.request

VERSION = 'v0.37.1'
NAME = f'geckodriver-{VERSION}-linux64.tar.gz'

def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'weespy-connect-installer'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(20_000_001)
    if len(data) > 20_000_000:
        raise ValueError('Download too large')
    return data

def main():
    release = json.loads(download(f'https://api.github.com/repos/mozilla/geckodriver/releases/tags/{VERSION}'))
    asset = next(a for a in release['assets'] if a['name'] == NAME)
    url = f'https://github.com/mozilla/geckodriver/releases/download/{VERSION}/{NAME}'
    if asset['browser_download_url'] != url:
        raise ValueError('Unexpected release URL')
    archive = download(url)
    if asset.get('digest') != 'sha256:' + hashlib.sha256(archive).hexdigest():
        raise ValueError('Release digest missing or invalid; installation stopped')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        member = tar.getmember('geckodriver')
        if not member.isfile() or member.size > 30_000_000:
            raise ValueError('Unexpected driver archive')
        driver = tar.extractfile(member).read()
    path = pathlib.Path('geckodriver')
    with path.open('xb') as stream:
        stream.write(driver)
    path.chmod(0o755)
    print('Mozilla driver verified and prepared.')

if __name__ == '__main__':
    main()
