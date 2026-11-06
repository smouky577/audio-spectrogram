# Аудио спектрограма

Спектрограма в реално време от микрофон, от звуков файл или от картинка. Картинката се превръща в звук и се вижда върху спектрограмата.

Има версия за телефон и версия за Windows. Текущата версия е **1.1**.

## Какво е новото в 1.1

- **Запази екран** снима само спектрограмата. Вълната отгоре и числата с херцовете не влизат в снимката, затова звукът от нея се чува силно и се разбира.
- На Windows файловете не отиват в Downloads. Снимките са в `picture`, записът от микрофона е в `record`, а звукът от картинка е в `sound`.
- На телефона и трите неща остават в `Documents/Spectrogram`.

## Телефон

Свали **Spectrogram.apk** от [Releases](https://github.com/smouky577/audio-spectrogram/releases/tag/v1.1) и го инсталирай. Ако Android попита, разреши инсталация от този файл.

Кодът за телефона е в папката `android`. Записите, звуците от картинки и снимките на екрана се пазят в `Documents/Spectrogram` на телефона.

## Windows

Вземи папката на проекта и цъкни два пъти върху `start.bat`. Той пуска локален адрес и отваря браузъра. Нужен е Python.

Файловете на програмата са в папката `www`.

---

# Audio spectrogram (English)

A live spectrogram from the microphone, an audio file, or a picture. A picture is turned into sound and shows up on the spectrogram.

There is a phone app and a Windows app. The current version is **1.1**.

## What is new in 1.1

- **Save screen** stores only the spectrogram. The waveform on top and the hertz labels are left out, so the sound played from that picture stays loud and intelligible.
- On Windows the files no longer go to Downloads. Pictures go to `picture`, microphone recordings go to `record`, and sound made from a picture goes to `sound`.
- On the phone all three still go to `Documents/Spectrogram`.

## Phone

Download **Spectrogram.apk** from [Releases](https://github.com/smouky577/audio-spectrogram/releases/tag/v1.1) and install it. Allow installation from this file if Android asks.

The phone source is in the `android` folder. Recordings, sounds made from pictures, and screen pictures are saved in `Documents/Spectrogram` on the phone.

## Windows

Open the project folder and double-click `start.bat`. It starts a local address and opens the browser. Python is required.

The app files are in the `www` folder.
