FROM weespy-radar-firefox:local
USER 0:0
RUN /opt/radar-venv/bin/pip install --no-cache-dir selenium==4.51.0
COPY geckodriver /usr/local/bin/geckodriver
RUN chmod 755 /usr/local/bin/geckodriver
LABEL weespy.operator.engine="vps-firefox-1"
