FROM eclipse-temurin:17-jdk-jammy@sha256:43f4431cc895d37ceb115e2e1f160545ec45caee9c1cb4246fc6bb879d58aeda
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip git build-essential python3 libpulse0 libnss3 libx11-6 libxcb1 libxcomposite1 libxcursor1 libxi6 libxtst6 libasound2 libxdamage1 libxfixes3 libxrandr2 libglu1-mesa && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/opt/android-sdk ANDROID_NDK_HOME=/opt/android-sdk/ndk/27.2.12479018
ENV PATH=/usr/local/go/bin:/root/go/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:$PATH
RUN curl -fsSL https://go.dev/dl/go1.26.9.linux-amd64.tar.gz -o /tmp/go.tar.gz && echo '42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d  /tmp/go.tar.gz' | sha256sum -c - && tar -C /usr/local -xzf /tmp/go.tar.gz && rm /tmp/go.tar.gz
RUN curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip -o /tmp/android.zip && echo '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583  /tmp/android.zip' | sha256sum -c - && mkdir -p $ANDROID_HOME/cmdline-tools && unzip -q /tmp/android.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && rm /tmp/android.zip
RUN yes | sdkmanager --licenses >/dev/null
RUN sdkmanager 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 'ndk;27.2.12479018'
WORKDIR /workspace/android
