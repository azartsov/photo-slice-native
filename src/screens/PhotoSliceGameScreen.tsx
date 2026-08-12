import { useEffect, useMemo, useRef, useState } from "react";

import { Directory, File, Paths } from "expo-file-system";
import { setAudioModeAsync, setIsAudioActiveAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { LinearGradient } from "expo-linear-gradient";
import * as MediaLibrary from "expo-media-library";
import { StatusBar } from "expo-status-bar";
import {
  Animated,
  Easing,
  Image,
  LayoutChangeEvent,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  Vibration,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, G, Polygon, Polyline, Rect } from "react-native-svg";

import {
  advanceGameState,
  createInitialGameState,
  getBoardSize,
  getCursorPosition,
  getCutTrail,
  getOpenPercent,
  PhotoSliceGameEvent,
  PhotoSliceGameState,
  polygonToSvgPoints,
  polylineToSvgPoints,
  requestTurn,
  startCut,
  stepGame,
  Vector2,
} from "../game/photo-slice-game";

type PhotoState = {
  uri: string | null;
  label: string;
  width: number | null;
  height: number | null;
};

type Language = "ru" | "en";

type SourceEntry = {
  id: string;
  kind: "camera" | "gallery" | "directory";
  uri?: string;
  name?: string;
};

type LayoutBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SparkBurst = {
  id: number;
  type: "life-lost" | "hazards-cleared" | "opened-progress" | "opened-photos";
  source: Vector2;
  target: Vector2;
  count: number;
};

type RandomPhotoCandidate = {
  uri: string;
  label: string;
};

type DifficultyLevel = "sunny" | "cloudy" | "stormy" | "blizzard" | "apocalypse";

type DifficultyTheme = {
  hazardCount: number;
  accent: string;
  foreground: string;
};

type OpenedPhotosByDifficulty = Record<DifficultyLevel, number>;

type NoticeState = {
  title: string;
  body: string;
} | null;

const MAX_FRAME_DELTA_SECONDS = 0.1;
const CAMERA_ALBUM_PATTERN = /(camera|камера|dcim)/i;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp"]);
const APP_STORAGE_DIRECTORY = new Directory(Paths.document, "random-photo-slice");
const APP_STATS_FILE = new File(APP_STORAGE_DIRECTORY, "stats.json");
const DEFAULT_SOURCE_ENTRIES: SourceEntry[] = [
  { id: "camera", kind: "camera" },
];
const EMPTY_OPENED_PHOTOS_BY_DIFFICULTY: OpenedPhotosByDifficulty = {
  sunny: 0,
  cloudy: 0,
  stormy: 0,
  blizzard: 0,
  apocalypse: 0,
};
const DIFFICULTY_ORDER: DifficultyLevel[] = ["sunny", "cloudy", "stormy", "blizzard", "apocalypse"];
const DIFFICULTY_THEMES: Record<DifficultyLevel, DifficultyTheme> = {
  sunny: {
    hazardCount: 3,
    accent: "#facc15",
    foreground: "#0f172a",
  },
  cloudy: {
    hazardCount: 4,
    accent: "#67e8f9",
    foreground: "#082f49",
  },
  stormy: {
    hazardCount: 5,
    accent: "#2563eb",
    foreground: "#dbeafe",
  },
  blizzard: {
    hazardCount: 6,
    accent: "#1e3a8a",
    foreground: "#eff6ff",
  },
  apocalypse: {
    hazardCount: 8,
    accent: "#020617",
    foreground: "#f8fafc",
  },
};
const UI_TEXT = {
  ru: {
    title: "Random Photo Slice",
    opened: "Открыто",
    hazards: "Враги",
    lives: "Жизни",
    wonTitle: "Фото полностью раскрыто",
    wonBody: "Все шурикены уничтожены. Теперь можно продолжить играть на новом случайном фото и при желании сменить сложность.",
    lostTitle: "Фото не удалось открыть",
    lostBody: "Все жизни закончились. При желании можно сменить уровень сложности, а затем нажать Играть, чтобы начать новую попытку на этом же фото.",
    playButton: "Играть",
    levelButton: "Сложность",
    levelReadyHint: "Доступно только до начала попытки",
    readyTitle: "Уровень готов",
    readyBody: "Нажмите Играть, чтобы начать попытку на текущем фото. Сейчас можно сменить уровень сложности.",
    ok: "ОК",
    loading: "Загрузка...",
    needPhotosTitle: "Нужен доступ к фото",
    needPhotosBody: "Без доступа к фото из каталога камеры игра не сможет выбрать стартовый снимок как уровень.",
    noPhotosTitle: "Фотографии не найдены",
    noPhotosBody: "В выбранных каталогах не нашлось подходящих фото. Пока можно играть на demo backdrop. При необходимости измените директории для поиска случайных фото в настройках.",
    libraryErrorTitle: "Не удалось открыть медиатеку",
    libraryErrorBody: "Системный доступ к фото не ответил корректно.",
    helpTitle: "Как играть",
    helpLines: [
      "1. Курсор сам бежит по периметру закрытой части.",
      "2. Тап по полю запускает разрез внутрь фото.",
      "3. Пока идёт разрез, каждый следующий тап поворачивает линию на 90° в сторону тапа.",
      "4. Если шурикен касается линии, попытка отменяется и тратится жизнь.",
      "5. Когда линия упирается в границу, открывается меньшая область.",
      "6. Если шурикен оказался в открывшейся части, он уничтожается.",
      "7. Уровни сложности: Солнечный, Облачный, Штормовой, Ураганный и Апокалипсис. На них 3, 4, 5, 6 и 8 шурикенов.",
      "8. Счетчик открытых фото ведется отдельно для каждого уровня сложности и переключается вместе с ним.",
    ],
    close: "Закрыть",
    settingsTitle: "Настройки",
    languageTitle: "Язык интерфейса",
    sourceTitle: "Каталоги для случайного фото",
    languageRu: "Русский",
    languageEn: "Английский",
    sourceCamera: "Камера",
    sourceGallery: "Галерея",
    addFolder: "Добавить каталог",
    removeFolder: "Удалить",
    sourceEmpty: "Список каталогов пуст. Добавьте хотя бы один источник.",
    folderAlreadyAdded: "Этот каталог уже добавлен в список источников.",
    folderPickerErrorTitle: "Не удалось выбрать каталог",
    folderPickerErrorBody: "Системный выбор каталога не завершился корректно.",
    demoLabel: "Демо-фон",
    randomLabel: "Случайное фото",
    startGame: "Play!",
    difficultySunny: "Солнечный",
    difficultyCloudy: "Облачный",
    difficultyStormy: "Штормовой",
    difficultyBlizzard: "Ураганный",
    difficultyApocalypse: "Апокалипсис",
    splashTitle: "Random Photo Slice",
    splashBody: "",
    settingsOn: "Вкл",
    settingsOff: "Выкл",
  },
  en: {
    title: "Random Photo Slice",
    opened: "Opened",
    hazards: "Enemies",
    lives: "Lives",
    wonTitle: "Photo fully revealed",
    wonBody: "All shurikens are gone. You can continue playing on a new random photo and change the difficulty now.",
    lostTitle: "Photo could not be revealed",
    lostBody: "No lives left. If you want, you can change the difficulty, then press Play to start a new run on the same photo.",
    playButton: "Play",
    levelButton: "Level",
    levelReadyHint: "Available only before a run starts",
    readyTitle: "Level ready",
    readyBody: "Press Play to start the run on the current photo. You can also change the difficulty now.",
    ok: "OK",
    loading: "Loading...",
    needPhotosTitle: "Photo access required",
    needPhotosBody: "The game needs access to your camera photos to pick the first level image.",
    noPhotosTitle: "No photos found",
    noPhotosBody: "No suitable photos were found in the selected folders. You can still play on the demo backdrop. If needed, change the directories used for random photo search in Settings.",
    libraryErrorTitle: "Could not open media library",
    libraryErrorBody: "The system media library request did not complete correctly.",
    helpTitle: "How to play",
    helpLines: [
      "1. The cursor moves along the edge of the hidden area.",
      "2. Tap the board to launch a cut into the photo.",
      "3. While the cut is moving, each new tap turns it by 90 degrees toward the tap side.",
      "4. If a shuriken touches the line, the attempt is canceled and you lose a life.",
      "5. When the line reaches the border, the smaller area is revealed.",
      "6. Any shuriken inside the revealed area is destroyed.",
      "7. Difficulty levels are Sunny, Cloudy, Stormy, Blizzard, and Apocalypse with 3, 4, 5, 6, and 8 shurikens.",
      "8. The opened photos counter is tracked separately for each difficulty level and changes when you switch levels.",
    ],
    close: "Close",
    settingsTitle: "Settings",
    languageTitle: "Interface language",
    sourceTitle: "Folders for random photos",
    languageRu: "Russian",
    languageEn: "English",
    sourceCamera: "Camera",
    sourceGallery: "Gallery",
    addFolder: "Add folder",
    removeFolder: "Remove",
    sourceEmpty: "The folder list is empty. Add at least one source.",
    folderAlreadyAdded: "This folder is already in the source list.",
    folderPickerErrorTitle: "Could not select folder",
    folderPickerErrorBody: "The system directory picker did not complete correctly.",
    demoLabel: "Demo backdrop",
    randomLabel: "Random photo",
    startGame: "Play!",
    difficultySunny: "Sunny",
    difficultyCloudy: "Cloudy",
    difficultyStormy: "Stormy",
    difficultyBlizzard: "Blizzard",
    difficultyApocalypse: "Apocalypse",
    splashTitle: "Random Photo Slice",
    splashBody: "",
    settingsOn: "ON",
    settingsOff: "OFF",
  },
} as const;

export function PhotoSliceGameScreen() {
  const dimensions = useWindowDimensions();
  const [difficulty, setDifficulty] = useState<DifficultyLevel>("stormy");
  const [gameState, setGameState] = useState<PhotoSliceGameState>(() => createInitialGameState(DIFFICULTY_THEMES.stormy.hazardCount));
  const [language, setLanguage] = useState<Language>("ru");
  const [sourceEntries, setSourceEntries] = useState<SourceEntry[]>(DEFAULT_SOURCE_ENTRIES);
  const [photo, setPhoto] = useState<PhotoState>({
    uri: null,
    label: "Demo backdrop",
    width: null,
    height: null,
  });
  const [loadingPhoto, setLoadingPhoto] = useState(false);
  const [attemptStarted, setAttemptStarted] = useState(false);
  const [wonOverlayDismissed, setWonOverlayDismissed] = useState(false);
  const [introVisible, setIntroVisible] = useState(true);
  const [helpVisible, setHelpVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [bursts, setBursts] = useState<SparkBurst[]>([]);
  const [openedPhotosByDifficulty, setOpenedPhotosByDifficulty] = useState<OpenedPhotosByDifficulty>(EMPTY_OPENED_PHOTOS_BY_DIFFICULTY);
  const [openedLayout, setOpenedLayout] = useState<LayoutBox | null>(null);
  const [boardLayout, setBoardLayout] = useState<LayoutBox | null>(null);
  const [hazardsLayout, setHazardsLayout] = useState<LayoutBox | null>(null);
  const [livesLayout, setLivesLayout] = useState<LayoutBox | null>(null);
  const boardShellRef = useRef<View | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const attemptedInitialPhotoRef = useRef(false);
  const eventNonceRef = useRef(0);
  const burstIdRef = useRef(1);
  const suppressNextOpenedSoundRef = useRef(false);
  const previousStatusRef = useRef(gameState.status);
  const previousOpenPercentRef = useRef<number | null>(null);
  const previousOpenedPhotosCountRef = useRef<number | null>(null);
  const pendingSoundRef = useRef<"paper-rustle" | "hazard-clear" | null>(null);
  const audioPrimedRef = useRef(false);
  const paperRustlePlayer = useAudioPlayer(require("../../assets/sfx/paper-rustle.wav"), { keepAudioSessionActive: true });
  const hazardClearPlayer = useAudioPlayer(require("../../assets/sfx/hazard-clear.wav"), { keepAudioSessionActive: true });
  const paperRustleStatus = useAudioPlayerStatus(paperRustlePlayer);
  const hazardClearStatus = useAudioPlayerStatus(hazardClearPlayer);
  const openedScale = useRef(new Animated.Value(1)).current;
  const hazardsScale = useRef(new Animated.Value(1)).current;
  const livesScale = useRef(new Animated.Value(1)).current;
  const boardSizePx = useMemo(() => Math.max(260, Math.min(dimensions.width - 56, dimensions.height * 0.56)), [dimensions.height, dimensions.width]);
  const difficultyTheme = DIFFICULTY_THEMES[difficulty];

  useEffect(() => {
    paperRustlePlayer.volume = 0.24;
    hazardClearPlayer.volume = 0.5;
  }, [hazardClearPlayer, paperRustlePlayer]);

  useEffect(() => {
    if (audioPrimedRef.current || !paperRustleStatus.isLoaded || !hazardClearStatus.isLoaded) {
      return;
    }

    audioPrimedRef.current = true;
    void Promise.all([paperRustlePlayer.seekTo(0), hazardClearPlayer.seekTo(0)]).catch((error) => {
      console.warn("audio prime failed", error);
    });
  }, [hazardClearPlayer, hazardClearStatus.isLoaded, paperRustlePlayer, paperRustleStatus.isLoaded]);

  useEffect(() => {
    const pendingSound = pendingSoundRef.current;
    if (!pendingSound) {
      return;
    }

    if (pendingSound === "paper-rustle" && paperRustleStatus.isLoaded) {
      pendingSoundRef.current = null;
      playSound(paperRustlePlayer);
      return;
    }

    if (pendingSound === "hazard-clear" && hazardClearStatus.isLoaded) {
      pendingSoundRef.current = null;
      playSound(hazardClearPlayer);
    }
  }, [hazardClearPlayer, hazardClearStatus.isLoaded, paperRustlePlayer, paperRustleStatus.isLoaded]);

  useEffect(() => {
    let cancelled = false;

    async function prepareAudio() {
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: false,
          interruptionMode: "mixWithOthers",
          shouldRouteThroughEarpiece: false,
        });

        if (cancelled) {
          return;
        }

        await setIsAudioActiveAsync(true);
      } catch (error) {
        console.warn("audio init failed", error);
      }
    }

    void prepareAudio();

    return () => {
      cancelled = true;
      void setIsAudioActiveAsync(false);
    };
  }, []);

  useEffect(() => {
    let frameId = 0;

    function loop(timestamp: number) {
      if (lastFrameRef.current == null) {
        lastFrameRef.current = timestamp;
      }

      const delta = Math.min((timestamp - lastFrameRef.current) / 1000, MAX_FRAME_DELTA_SECONDS);
      lastFrameRef.current = timestamp;
      setGameState((current) => advanceGameState(current, delta));
      frameId = requestAnimationFrame(loop);
    }

    frameId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frameId);
      lastFrameRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (attemptedInitialPhotoRef.current) {
      return;
    }

    attemptedInitialPhotoRef.current = true;
    void handleRandomPhoto(false);
  }, []);

  useEffect(() => {
    void loadOpenedPhotosCount();
  }, []);

  const cursor = getCursorPosition(gameState);
  const cutTrail = gameState.activeCut ? getCutTrail(gameState.activeCut) : null;
  const openPercent = getOpenPercent(gameState);
  const hazardsLeft = gameState.hazards.length;
  const copy = UI_TEXT[language];
  const openedPhotosCount = openedPhotosByDifficulty[difficulty];
  const canPressPlay = !loadingPhoto && !attemptStarted;
  const canChangeDifficulty = !loadingPhoto && !attemptStarted;

  useEffect(() => {
    setPhoto((current) => (current.uri ? current : { ...current, label: copy.demoLabel }));
  }, [copy.demoLabel]);

  useEffect(() => {
    if (!gameState.lastEvent || gameState.eventNonce === 0 || gameState.eventNonce === eventNonceRef.current) {
      return;
    }

    eventNonceRef.current = gameState.eventNonce;
    handleGameEvent(gameState.lastEvent);
  }, [gameState.eventNonce, gameState.lastEvent]);

  useEffect(() => {
    if (previousStatusRef.current !== "won" && gameState.status === "won") {
      setWonOverlayDismissed(false);
      setOpenedPhotosByDifficulty((current) => {
        const nextCounts = {
          ...current,
          [difficulty]: current[difficulty] + 1,
        };
        void persistOpenedPhotosCount(nextCounts);
        return nextCounts;
      });
    }

    if (gameState.status === "won" || gameState.status === "lost") {
      setAttemptStarted(false);
    }

    if (gameState.status !== "won") {
      setWonOverlayDismissed(false);
    }

    previousStatusRef.current = gameState.status;
  }, [gameState.status]);

  useEffect(() => {
    if (!attemptStarted && gameState.status !== "won") {
      setGameState(createInitialGameState(difficultyTheme.hazardCount));
      setBursts([]);
    }
  }, [difficultyTheme.hazardCount]);

  useEffect(() => {
    if (previousOpenPercentRef.current == null) {
      previousOpenPercentRef.current = openPercent;
      return;
    }

    if (openPercent > previousOpenPercentRef.current) {
      triggerOpenedFeedback("opened-progress", Math.max(1, openPercent - previousOpenPercentRef.current));

      if (suppressNextOpenedSoundRef.current) {
        suppressNextOpenedSoundRef.current = false;
      } else {
        queueSound("paper-rustle");
      }
    }

    previousOpenPercentRef.current = openPercent;
  }, [openPercent]);

  useEffect(() => {
    if (previousOpenedPhotosCountRef.current == null) {
      previousOpenedPhotosCountRef.current = openedPhotosCount;
      return;
    }

    if (openedPhotosCount > previousOpenedPhotosCountRef.current) {
      triggerOpenedFeedback("opened-photos", openedPhotosCount - previousOpenedPhotosCountRef.current);
    }

    previousOpenedPhotosCountRef.current = openedPhotosCount;
  }, [openedPhotosCount]);

  async function loadOpenedPhotosCount() {
    try {
      if (!APP_STORAGE_DIRECTORY.exists) {
        APP_STORAGE_DIRECTORY.create({ idempotent: true, intermediates: true });
      }

      if (!APP_STATS_FILE.exists) {
        setOpenedPhotosByDifficulty(EMPTY_OPENED_PHOTOS_BY_DIFFICULTY);
        return;
      }

      const raw = await APP_STATS_FILE.text();
      const parsed = JSON.parse(raw) as {
        openedPhotosCount?: number;
        openedPhotosByDifficulty?: Partial<OpenedPhotosByDifficulty>;
      };

      if (parsed.openedPhotosByDifficulty) {
        setOpenedPhotosByDifficulty({
          sunny: parsed.openedPhotosByDifficulty.sunny ?? 0,
          cloudy: parsed.openedPhotosByDifficulty.cloudy ?? 0,
          stormy: parsed.openedPhotosByDifficulty.stormy ?? 0,
          blizzard: parsed.openedPhotosByDifficulty.blizzard ?? 0,
          apocalypse: parsed.openedPhotosByDifficulty.apocalypse ?? 0,
        });
        return;
      }

      if (Number.isFinite(parsed.openedPhotosCount)) {
        setOpenedPhotosByDifficulty({
          ...EMPTY_OPENED_PHOTOS_BY_DIFFICULTY,
          stormy: parsed.openedPhotosCount ?? 0,
        });
        return;
      }

      setOpenedPhotosByDifficulty(EMPTY_OPENED_PHOTOS_BY_DIFFICULTY);
    } catch (error) {
      console.warn("could not load app stats", error);
      setOpenedPhotosByDifficulty(EMPTY_OPENED_PHOTOS_BY_DIFFICULTY);
    }
  }

  async function persistOpenedPhotosCount(nextCounts: OpenedPhotosByDifficulty) {
    try {
      if (!APP_STORAGE_DIRECTORY.exists) {
        APP_STORAGE_DIRECTORY.create({ idempotent: true, intermediates: true });
      }

      if (!APP_STATS_FILE.exists) {
        APP_STATS_FILE.create({ intermediates: true, overwrite: true });
      }

      APP_STATS_FILE.write(JSON.stringify({ openedPhotosByDifficulty: nextCounts }));
    } catch (error) {
      console.warn("could not persist app stats", error);
    }
  }

  async function handleRandomPhoto(startAttempt = false, nextDifficulty = difficulty) {
    const nextTheme = DIFFICULTY_THEMES[nextDifficulty];

    setLoadingPhoto(true);
    try {
      const candidates = await collectRandomPhotoCandidates(sourceEntries, copy);

      if (candidates.length === 0) {
        setNotice({
          title: copy.noPhotosTitle,
          body: copy.noPhotosBody,
        });
        setPhoto({
          uri: null,
          label: copy.demoLabel,
          width: null,
          height: null,
        });
        setBursts([]);
        setGameState(createInitialGameState(nextTheme.hazardCount));
        setAttemptStarted(startAttempt);
        return;
      }

      const selectedAsset = candidates[Math.floor(Math.random() * candidates.length)];
      const imageSize = await getImageSize(selectedAsset.uri);
      setPhoto({
        uri: selectedAsset.uri,
        label: selectedAsset.label,
        width: imageSize.width,
        height: imageSize.height,
      });
      setBursts([]);
      setGameState(createInitialGameState(nextTheme.hazardCount));
      setAttemptStarted(startAttempt);
    } catch (error) {
      setPhoto({
        uri: null,
        label: copy.demoLabel,
        width: null,
        height: null,
      });
      setBursts([]);
      setGameState(createInitialGameState(nextTheme.hazardCount));
      setAttemptStarted(startAttempt);

      if (error instanceof Error && error.message === "permission-denied") {
        setNotice({
          title: copy.needPhotosTitle,
          body: copy.needPhotosBody,
        });
      } else {
        setNotice({
          title: copy.libraryErrorTitle,
          body: copy.libraryErrorBody,
        });
      }
      console.warn("random library photo failed", error);
    } finally {
      setLoadingPhoto(false);
    }
  }

  async function handleAddFolder() {
    try {
      const directory = await Directory.pickDirectoryAsync();
      setSourceEntries((current) => {
        if (current.some((entry) => entry.uri === directory.uri)) {
          setNotice({
            title: copy.folderPickerErrorTitle,
            body: copy.folderAlreadyAdded,
          });
          return current;
        }

        return [
          ...current,
          {
            id: directory.uri,
            kind: "directory",
            uri: directory.uri,
            name: getDirectoryDisplayName(directory.uri),
          },
        ];
      });
    } catch (error) {
      console.warn("directory picker failed", error);
      setNotice({
        title: copy.folderPickerErrorTitle,
        body: copy.folderPickerErrorBody,
      });
    }
  }

  function handleRemoveSource(id: string) {
    setSourceEntries((current) => current.filter((entry) => entry.id !== id));
  }

  function resetLevel() {
    setGameState(createInitialGameState(difficultyTheme.hazardCount));
    setBursts([]);
    setAttemptStarted(false);
  }

  async function handlePlayPress() {
    if (!canPressPlay) {
      return;
    }

    if (gameState.status === "won") {
      await handleRandomPhoto(true);
      return;
    }

    setBursts([]);
    setGameState(createInitialGameState(difficultyTheme.hazardCount));
    setAttemptStarted(true);
  }

  function queueSound(effect: "paper-rustle" | "hazard-clear") {
    if (effect === "paper-rustle") {
      if (paperRustleStatus.isLoaded) {
        playSound(paperRustlePlayer);
        return;
      }
    } else if (hazardClearStatus.isLoaded) {
      playSound(hazardClearPlayer);
      return;
    }

    pendingSoundRef.current = effect;
  }

  async function handleCycleDifficulty() {
    if (!canChangeDifficulty) {
      return;
    }

    const currentIndex = DIFFICULTY_ORDER.indexOf(difficulty);
    const nextDifficulty = DIFFICULTY_ORDER[(currentIndex + 1) % DIFFICULTY_ORDER.length];
    const shouldLoadNewPhoto = gameState.status === "won";

    setDifficulty(nextDifficulty);
    setBursts([]);
    setAttemptStarted(false);
    setWonOverlayDismissed(false);

    if (shouldLoadNewPhoto) {
      await handleRandomPhoto(false, nextDifficulty);
      return;
    }

    setGameState(createInitialGameState(DIFFICULTY_THEMES[nextDifficulty].hazardCount));
  }

  function handleGameEvent(event: PhotoSliceGameEvent) {
    const targetLayout = event.type === "life-lost" ? livesLayout : hazardsLayout;
    const targetScale = event.type === "life-lost" ? livesScale : hazardsScale;

    if (event.type === "life-lost") {
      Vibration.vibrate(40);
    } else {
      suppressNextOpenedSoundRef.current = true;
      queueSound("hazard-clear");
    }

    pulseCounter(targetScale);

    if (!boardLayout || !targetLayout) {
      return;
    }

    const source = {
      x: boardLayout.x + (event.source.x / getBoardSize()) * boardLayout.width,
      y: boardLayout.y + (event.source.y / getBoardSize()) * boardLayout.height,
    };
    const target = {
      x: targetLayout.x + targetLayout.width / 2,
      y: targetLayout.y + targetLayout.height / 2,
    };

    setBursts((current) => [
      ...current,
      {
        id: burstIdRef.current++,
        type: event.type,
        source,
        target,
        count: event.count,
      },
    ]);
  }

  function triggerOpenedFeedback(type: "opened-progress" | "opened-photos", count: number) {
    pulseCounter(openedScale);

    if (!boardLayout || !openedLayout) {
      return;
    }

    const source = {
      x: boardLayout.x + (cursor.x / getBoardSize()) * boardLayout.width,
      y: boardLayout.y + (cursor.y / getBoardSize()) * boardLayout.height,
    };
    const target = {
      x: openedLayout.x + openedLayout.width / 2,
      y: openedLayout.y + openedLayout.height / 2,
    };

    setBursts((current) => [
      ...current,
      {
        id: burstIdRef.current++,
        type,
        source,
        target,
        count,
      },
    ]);
  }

  function pulseCounter(value: Animated.Value) {
    value.stopAnimation();
    value.setValue(1);
    Animated.sequence([
      Animated.timing(value, {
        toValue: 1.3,
        duration: 160,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(value, {
        toValue: 0.8,
        duration: 150,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(value, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.back(1.3)),
        useNativeDriver: true,
      }),
    ]).start();
  }

  function captureLayout(setter: (layout: LayoutBox) => void) {
    return (event: LayoutChangeEvent) => {
      setter(event.nativeEvent.layout);
    };
  }

  function handleStagePress(pageX: number, pageY: number) {
    if (!attemptStarted || gameState.status !== "playing" || !boardShellRef.current) {
      return;
    }

    boardShellRef.current.measureInWindow((boardX, boardY, boardWidth, boardHeight) => {
      if (!boardWidth || !boardHeight) {
        return;
      }

      const boardPoint = {
        x: ((pageX - boardX) / boardWidth) * getBoardSize(),
        y: ((pageY - boardY) / boardHeight) * getBoardSize(),
      };

      setGameState((current) => (current.activeCut ? requestTurn(current, boardPoint) : startCut(current, boardPoint)));
    });
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content} bounces={false}>
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={styles.titleRow}>
              <GameTitleMark title={copy.title} variant="header" />
            </View>
            <View style={styles.headerActions}>
              <IconButton label="?" onPress={() => setHelpVisible(true)} />
              <IconButton label="⚙" onPress={() => setSettingsVisible(true)} />
            </View>
          </View>
        </View>

        <View style={styles.gameStage}>
          <Pressable style={styles.stageCard} onPress={(event) => handleStagePress(event.nativeEvent.pageX, event.nativeEvent.pageY)}>
            <View style={styles.statsRow}>
              <OpenedStatCard
                label={copy.opened}
                primaryValue={`${openPercent}%`}
                secondaryValue={String(openedPhotosCount)}
                scale={openedScale}
                onLayout={captureLayout(setOpenedLayout)}
              />
              <StatCard label={copy.hazards} value={String(hazardsLeft)} scale={hazardsScale} onLayout={captureLayout(setHazardsLayout)} accentColor="#fde047" />
              <StatCard label={copy.lives} value={String(gameState.lives)} scale={livesScale} onLayout={captureLayout(setLivesLayout)} accentColor="#67e8f9" />
            </View>

            <View
              ref={boardShellRef}
              style={[styles.boardShell, { width: boardSizePx, height: boardSizePx, borderColor: difficultyTheme.accent }]}
              onLayout={captureLayout(setBoardLayout)}
            >
              {photo.uri ? (
                <BoardPhoto photo={photo} boardSizePx={boardSizePx} />
              ) : (
                <DemoBackdrop />
              )}

              <Svg width="100%" height="100%" viewBox={`0 0 ${getBoardSize()} ${getBoardSize()}`}>
                {gameState.status !== "won" ? (
                  <Polygon points={polygonToSvgPoints(gameState.hiddenPolygon)} fill="rgba(7, 15, 31, 0.94)" />
                ) : null}

                <Rect x="0" y="0" width={getBoardSize()} height={getBoardSize()} fill="transparent" stroke="rgba(255,255,255,0.85)" strokeWidth="8" rx="26" />

                {gameState.hazards.map((hazard) => (
                  <G key={hazard.id} rotation={hazard.angle} origin={`${hazard.position.x}, ${hazard.position.y}`}>
                    <Polygon points={buildShurikenPoints(hazard.position, hazard.radius)} fill="#f97316" stroke="#fff5ea" strokeWidth="5" />
                    <Circle cx={hazard.position.x} cy={hazard.position.y} r={hazard.radius * 0.28} fill="#fff8ef" />
                  </G>
                ))}

                {cutTrail && cutTrail.length > 1 ? (
                  <>
                    <Polyline points={polylineToSvgPoints(cutTrail)} fill="none" stroke="#67e8f9" strokeWidth="12" strokeLinejoin="round" strokeLinecap="round" />
                    <Circle cx={cursor.x} cy={cursor.y} r="17" fill="#ecfeff" stroke="#06b6d4" strokeWidth="6" />
                  </>
                ) : (
                  <Circle cx={cursor.x} cy={cursor.y} r="16" fill="#f8fafc" stroke="#0ea5e9" strokeWidth="7" />
                )}
              </Svg>

              {gameState.status === "won" && !wonOverlayDismissed ? (
                <View style={styles.overlayBanner}>
                  <Text style={styles.overlayTitle}>{copy.wonTitle}</Text>
                  <Text style={styles.overlayText}>{copy.wonBody}</Text>
                  <Pressable style={styles.overlayButton} onPress={() => setWonOverlayDismissed(true)}>
                    <Text style={styles.overlayButtonText}>{copy.ok}</Text>
                  </Pressable>
                </View>
              ) : null}

              {!attemptStarted && gameState.status === "playing" ? (
                <View style={styles.overlayBanner}>
                  <Text style={styles.overlayTitle}>{copy.readyTitle}</Text>
                  <Text style={styles.overlayText}>{copy.readyBody}</Text>
                </View>
              ) : null}

              {gameState.status === "lost" ? (
                <View style={styles.overlayBanner}>
                  <Text style={styles.overlayTitle}>{copy.lostTitle}</Text>
                  <Text style={styles.overlayText}>{copy.lostBody}</Text>
                </View>
              ) : null}
            </View>

            <View pointerEvents="none" style={styles.stageOverlay}>
              {bursts.map((burst) => (
                <SparkBurstLayer key={burst.id} burst={burst} onComplete={() => setBursts((current) => current.filter((item) => item.id !== burst.id))} />
              ))}
            </View>
          </Pressable>
        </View>

        <View style={styles.controlsCard}>
          <View style={styles.buttonGrid}>
            <ActionButton label={loadingPhoto ? copy.loading : copy.playButton} disabled={!canPressPlay} stretch onPress={() => void handlePlayPress()} />
            <ActionButton
              label={getDifficultyLabel(difficulty, copy)}
              accentColor={difficultyTheme.accent}
              textColor={difficultyTheme.foreground}
              disabled={!canChangeDifficulty}
              stretch
              onPress={() => void handleCycleDifficulty()}
            />
          </View>
        </View>
      </ScrollView>

      <OverlaySheet visible={helpVisible} title={copy.helpTitle} onClose={() => setHelpVisible(false)} closeLabel={copy.close}>
        {copy.helpLines.map((line) => (
          <Text key={line} style={styles.helpLine}>
            {line}
          </Text>
        ))}
      </OverlaySheet>

      <OverlaySheet visible={settingsVisible} title={copy.settingsTitle} onClose={() => setSettingsVisible(false)} closeLabel={copy.close}>
        <View style={styles.settingSection}>
          <Text style={styles.settingTitle}>{copy.languageTitle}</Text>
          <OptionRow label={copy.languageRu} active={language === "ru"} onPress={() => setLanguage("ru")} activeLabel={copy.settingsOn} inactiveLabel={copy.settingsOff} />
          <OptionRow label={copy.languageEn} active={language === "en"} onPress={() => setLanguage("en")} activeLabel={copy.settingsOn} inactiveLabel={copy.settingsOff} />
        </View>

        <View style={styles.settingSection}>
          <Text style={styles.settingTitle}>{copy.sourceTitle}</Text>
          {sourceEntries.length === 0 ? <Text style={styles.sourceEmptyText}>{copy.sourceEmpty}</Text> : null}
          {sourceEntries.map((entry) => (
            <SourceEntryRow
              key={entry.id}
              label={getSourceEntryLabel(entry, copy)}
              removeLabel={copy.removeFolder}
              onRemove={() => handleRemoveSource(entry.id)}
            />
          ))}
          <Pressable style={styles.addFolderButton} onPress={() => void handleAddFolder()}>
            <Text style={styles.addFolderButtonPlus}>+</Text>
            <Text style={styles.addFolderButtonText}>{copy.addFolder}</Text>
          </Pressable>
        </View>
      </OverlaySheet>

      <NoticeDialog visible={notice != null} title={notice?.title ?? ""} body={notice?.body ?? ""} closeLabel={copy.close} onClose={() => setNotice(null)} />

      <Modal animationType="fade" transparent visible={introVisible} onRequestClose={() => setIntroVisible(false)}>
        <ScrollView
          style={styles.introBackdrop}
          contentContainerStyle={styles.introBackdropContent}
          bounces={false}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.introCard}>
            <GameTitleMark title={copy.splashTitle} variant="intro" />
            <GameplayPreview />
            <ActionButton label={copy.startGame} onPress={() => setIntroVisible(false)} />
          </View>
        </ScrollView>
      </Modal>
    </View>
  );
}

function NoticeDialog({
  visible,
  title,
  body,
  closeLabel,
  onClose,
}: {
  visible: boolean;
  title: string;
  body: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={[styles.modalCard, styles.noticeCard]} onPress={() => undefined}>
          <View style={styles.noticeBadge}>
            <Text style={styles.noticeBadgeText}>i</Text>
          </View>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.noticeBody}>{body}</Text>
          <ActionButton label={closeLabel} onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function playSound(player: ReturnType<typeof useAudioPlayer>) {
  try {
    void player.seekTo(0);
    player.play();
  } catch (error) {
    console.warn("sound playback failed", error);
  }
}

function DemoBackdrop() {
  return (
    <LinearGradient colors={["#071220", "#12375e", "#f97316"]} style={StyleSheet.absoluteFillObject}>
      <View style={styles.demoGlowLarge} />
      <View style={styles.demoGlowSmall} />
      <View style={styles.demoStamp}>
        <Text style={styles.demoStampText}>DEMO PHOTO</Text>
      </View>
    </LinearGradient>
  );
}

function GameTitleMark({ title, variant }: { title: string; variant: "header" | "intro" }) {
  const isIntro = variant === "intro";

  return (
    <View style={[styles.titleMark, isIntro ? styles.titleMarkIntro : styles.titleMarkHeader]}>
      <View style={[styles.titleMarkAccent, isIntro ? styles.titleMarkAccentIntro : null]} />
      <View style={[styles.titleGlyphWrap, isIntro ? styles.titleGlyphWrapIntro : null]}>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.55}
          style={[styles.titleGlyphText, isIntro ? styles.titleGlyphTextIntro : styles.titleGlyphTextHeader]}
        >
          {title}
        </Text>
      </View>
    </View>
  );
}

function BoardPhoto({ photo, boardSizePx }: { photo: PhotoState; boardSizePx: number }) {
  if (!photo.uri) {
    return null;
  }

  if (!photo.width || !photo.height) {
    return <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />;
  }

  const scale = Math.max(boardSizePx / photo.width, boardSizePx / photo.height);
  const width = photo.width * scale;
  const height = photo.height * scale;

  return (
    <View style={styles.boardPhotoViewport}>
      <Image
        source={{ uri: photo.uri }}
        style={{
          width,
          height,
          marginLeft: (boardSizePx - width) / 2,
          marginTop: (boardSizePx - height) / 2,
        }}
      />
    </View>
  );
}

function OverlaySheet({
  visible,
  title,
  closeLabel,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>{title}</Text>
          <View style={styles.modalBody}>{children}</View>
          <ActionButton label={closeLabel} onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function OptionRow({
  label,
  active,
  onPress,
  activeLabel,
  inactiveLabel,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <Pressable style={[styles.optionRow, active ? styles.optionRowActive : null]} onPress={onPress}>
      <Text style={[styles.optionRowText, active ? styles.optionRowTextActive : null]}>{label}</Text>
      <Text style={[styles.optionRowMarker, active ? styles.optionRowTextActive : null]}>{active ? activeLabel : inactiveLabel}</Text>
    </Pressable>
  );
}

function GameplayPreview() {
  return (
    <View style={styles.previewShell}>
      <LinearGradient colors={["#102341", "#1d4f83", "#f97316"]} style={StyleSheet.absoluteFillObject}>
        <Svg width="100%" height="100%" viewBox="0 0 1000 760">
          <Polygon points="0,0 1000,0 1000,760 0,760" fill="transparent" />
          <Polygon points="0,0 1000,0 1000,760 0,760" fill="transparent" stroke="rgba(255,255,255,0.86)" strokeWidth="18" />
          <Polygon points="0,0 1000,0 1000,760 0,760 0,460 280,520 360,360 0,300" fill="rgba(8, 17, 31, 0.76)" />
          <Polygon points="0,300 360,360 280,520 0,460" fill="rgba(255,255,255,0.12)" />
          <Polyline points="120,0 120,240 320,240 320,520" fill="none" stroke="#67e8f9" strokeWidth="18" strokeLinejoin="round" strokeLinecap="round" />
          <Circle cx="320" cy="520" r="26" fill="#ecfeff" stroke="#06b6d4" strokeWidth="10" />
          <G rotation="28" origin="720, 250">
            <Polygon points={buildShurikenPoints({ x: 720, y: 250 }, 62)} fill="#f97316" stroke="#fff5ea" strokeWidth="12" />
            <Circle cx="720" cy="250" r="18" fill="#fff8ef" />
          </G>
          <G rotation="-14" origin="650, 560">
            <Polygon points={buildShurikenPoints({ x: 650, y: 560 }, 54)} fill="#f97316" stroke="#fff5ea" strokeWidth="10" />
            <Circle cx="650" cy="560" r="16" fill="#fff8ef" />
          </G>
        </Svg>
      </LinearGradient>
    </View>
  );
}

function SourceEntryRow({ label, removeLabel, onRemove }: { label: string; removeLabel: string; onRemove: () => void }) {
  return (
    <View style={styles.sourceEntryRow}>
      <Text style={styles.sourceEntryText}>{label}</Text>
      <Pressable style={styles.removeSourceButton} onPress={onRemove}>
        <Text style={styles.removeSourceButtonText}>{removeLabel}</Text>
      </Pressable>
    </View>
  );
}

function IconButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.iconButton} onPress={onPress}>
      <Text style={styles.iconButtonText}>{label}</Text>
    </Pressable>
  );
}

function StatCard({
  label,
  value,
  scale,
  onLayout,
  accentColor,
}: {
  label: string;
  value: string;
  scale?: Animated.Value;
  onLayout?: (event: LayoutChangeEvent) => void;
  accentColor?: string;
}) {
  const Container = scale ? Animated.View : View;
  return (
    <Container style={[styles.statCard, scale ? { transform: [{ scale }] } : null, accentColor ? { borderColor: `${accentColor}33` } : null]} onLayout={onLayout}>
      <Text style={styles.statLabel}>{label}</Text>
      <View style={[styles.statValueFrame, accentColor ? { borderColor: `${accentColor}26` } : null]}>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.68}
          style={[styles.statValue, accentColor ? { color: accentColor } : null]}
        >
          {value}
        </Text>
      </View>
    </Container>
  );
}

function OpenedStatCard({
  label,
  primaryValue,
  secondaryValue,
  scale,
  onLayout,
}: {
  label: string;
  primaryValue: string;
  secondaryValue: string;
  scale?: Animated.Value;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const Container = scale ? Animated.View : View;

  return (
    <Container style={[styles.statCard, styles.openedStatCard, scale ? { transform: [{ scale }] } : null]} onLayout={onLayout}>
      <Text style={styles.statLabel}>{label}</Text>
      <View style={styles.openedStatValuesRow}>
        <View style={styles.statValueFrame}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.68} style={styles.statValue}>
            {primaryValue}
          </Text>
        </View>
        <View style={styles.statValueFrame}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.68} style={styles.statValue}>
            {secondaryValue}
          </Text>
        </View>
      </View>
    </Container>
  );
}

function SparkBurstLayer({ burst, onComplete }: { burst: SparkBurst; onComplete: () => void }) {
  const progress = useRef(new Animated.Value(0)).current;
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(0);

    Animated.timing(progress, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.exp),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        onCompleteRef.current();
      }
    });

    return () => {
      progress.stopAnimation();
    };
  }, [burst.id, progress]);

  const particles = useMemo(() => buildSparkParticles(burst), [burst]);
  const palette =
    burst.type === "life-lost"
      ? ["#67e8f9", "#dbeafe", "#0ea5e9"]
      : burst.type === "hazards-cleared"
        ? ["#fde047", "#fff7ae", "#f59e0b"]
        : ["#ffffff", "#f8fafc", "#e2e8f0"];

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      {particles.map((particle, index) => {
        const translateX = progress.interpolate({
          inputRange: [0, 0.52, 1],
          outputRange: [particle.start.x, particle.mid.x, particle.end.x],
        });
        const translateY = progress.interpolate({
          inputRange: [0, 0.52, 1],
          outputRange: [particle.start.y, particle.mid.y, particle.end.y],
        });
        const scale = progress.interpolate({
          inputRange: [0, 0.1, 0.72, 1],
          outputRange: [0.4, 1, 0.92, 0.2],
        });
        const opacity = progress.interpolate({
          inputRange: [0, 0.05, 0.72, 1],
          outputRange: [0, 1, 0.9, 0],
        });

        return (
          <Animated.View
            key={`${burst.id}-${index}`}
            style={[
              styles.spark,
              {
                width: particle.size,
                height: particle.size,
                borderRadius: particle.size,
                backgroundColor: palette[index % palette.length],
                opacity,
                transform: [{ translateX }, { translateY }, { scale }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

function ActionButton({
  label,
  caption,
  helperText,
  accentColor,
  textColor,
  stretch = false,
  onPress,
  disabled = false,
}: {
  label: string;
  caption?: string;
  helperText?: string;
  accentColor?: string;
  textColor?: string;
  stretch?: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.button,
        stretch ? styles.buttonStretch : styles.buttonAuto,
        accentColor ? { borderColor: `${accentColor}66`, backgroundColor: accentColor } : null,
        disabled ? styles.buttonDisabled : null,
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={[styles.buttonLabel, textColor ? { color: textColor } : null]}>{label}</Text>
      {caption ? <Text style={[styles.buttonCaption, textColor ? { color: textColor } : null]}>{caption}</Text> : null}
      {helperText ? <Text style={[styles.buttonHelper, textColor ? { color: `${textColor}CC` } : null]}>{helperText}</Text> : null}
    </Pressable>
  );
}

function getDifficultyLabel(level: DifficultyLevel, copy: (typeof UI_TEXT)[Language]) {
  switch (level) {
    case "sunny":
      return copy.difficultySunny;
    case "cloudy":
      return copy.difficultyCloudy;
    case "stormy":
      return copy.difficultyStormy;
    case "blizzard":
      return copy.difficultyBlizzard;
    case "apocalypse":
      return copy.difficultyApocalypse;
  }
}

function buildShurikenPoints(center: Vector2, radius: number): string {
  const points: Vector2[] = [];
  const totalPoints = 8;

  for (let index = 0; index < totalPoints; index += 1) {
    const angle = (Math.PI / 4) * index;
    const pointRadius = index % 2 === 0 ? radius : radius * 0.44;
    points.push({
      x: center.x + Math.cos(angle) * pointRadius,
      y: center.y + Math.sin(angle) * pointRadius,
    });
  }

  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function getImageSize(uri: string): Promise<{ width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve({ width: null, height: null }),
    );
  });
}

function buildSparkParticles(burst: SparkBurst) {
  const particlesCount = 9 + Math.min(6, burst.count * 2);
  const direction = {
    x: burst.target.x - burst.source.x,
    y: burst.target.y - burst.source.y,
  };
  const directionLength = Math.max(1, Math.hypot(direction.x, direction.y));
  const unit = {
    x: direction.x / directionLength,
    y: direction.y / directionLength,
  };
  const normal = {
    x: -unit.y,
    y: unit.x,
  };

  return Array.from({ length: particlesCount }, (_, index) => {
    const spread = ((index / Math.max(1, particlesCount - 1)) - 0.5) * 44;
    const distanceFactor = 0.28 + (index % 5) * 0.09;
    const arcLift = 12 + (index % 4) * 7;
    return {
      start: {
        x: burst.source.x + normal.x * spread,
        y: burst.source.y + normal.y * spread,
      },
      mid: {
        x: burst.source.x + direction.x * distanceFactor + normal.x * spread * 0.4,
        y: burst.source.y + direction.y * distanceFactor + normal.y * spread * 0.4 - arcLift,
      },
      end: {
        x: burst.target.x + normal.x * spread * 0.12,
        y: burst.target.y + normal.y * spread * 0.12,
      },
      size: 4 + (index % 3) * 2,
    };
  });
}

async function getCameraAlbumIds(): Promise<Set<string>> {
  const albums = await MediaLibrary.getAlbumsAsync();
  return new Set(albums.filter((album) => CAMERA_ALBUM_PATTERN.test(album.title)).map((album) => album.id));
}

async function collectRandomPhotoCandidates(sourceEntries: SourceEntry[], copy: (typeof UI_TEXT)[Language]) {
  const candidates: RandomPhotoCandidate[] = [];
  const needsMediaLibrary = sourceEntries.some((entry) => entry.kind === "camera" || entry.kind === "gallery");

  let mediaAssets: MediaLibrary.Asset[] = [];
  let cameraAlbumIds = new Set<string>();

  if (needsMediaLibrary) {
    const existingPermission = await MediaLibrary.getPermissionsAsync(false, ["photo"]);
    const permission = existingPermission.granted
      ? existingPermission
      : await MediaLibrary.requestPermissionsAsync(false, ["photo"]);

    if (!permission.granted) {
      throw new Error("permission-denied");
    }

    cameraAlbumIds = await getCameraAlbumIds();
    const page = await MediaLibrary.getAssetsAsync({
      first: 120,
      mediaType: MediaLibrary.MediaType.photo,
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
    mediaAssets = page.assets;
  }

  for (const entry of sourceEntries) {
    if (entry.kind === "camera") {
      const cameraAssets = mediaAssets.filter((asset) => asset.albumId && cameraAlbumIds.has(asset.albumId));
      for (const asset of cameraAssets) {
        candidates.push({
          uri: asset.uri,
          label: `${copy.randomLabel}: ${asset.filename}`,
        });
      }
      continue;
    }

    if (entry.kind === "gallery") {
      const galleryAssets = mediaAssets.filter((asset) => !asset.albumId || !cameraAlbumIds.has(asset.albumId));
      for (const asset of galleryAssets) {
        candidates.push({
          uri: asset.uri,
          label: `${copy.randomLabel}: ${asset.filename}`,
        });
      }
      continue;
    }

    if (entry.kind === "directory" && entry.uri) {
      candidates.push(...collectDirectoryPhotoCandidates(new Directory(entry.uri), getSourceEntryLabel(entry, copy)));
    }
  }

  return candidates;
}

function collectDirectoryPhotoCandidates(directory: Directory, sourceLabel: string, depth = 0): RandomPhotoCandidate[] {
  if (depth > 3) {
    return [];
  }

  let items: Array<Directory | File>;

  try {
    items = directory.list();
  } catch (error) {
    console.warn("directory list failed", directory.uri, error);
    return [];
  }

  const candidates: RandomPhotoCandidate[] = [];

  for (const item of items) {
    if (item instanceof File) {
      if (IMAGE_EXTENSIONS.has(item.extension.toLowerCase())) {
        candidates.push({
          uri: item.uri,
          label: `${sourceLabel}: ${item.name}`,
        });
      }
      continue;
    }

    candidates.push(...collectDirectoryPhotoCandidates(item, sourceLabel, depth + 1));
  }

  return candidates;
}

function getSourceEntryLabel(entry: SourceEntry, copy: (typeof UI_TEXT)[Language]) {
  if (entry.kind === "camera") {
    return copy.sourceCamera;
  }

  if (entry.kind === "gallery") {
    return copy.sourceGallery;
  }

  return entry.name ?? entry.uri ?? copy.sourceGallery;
}

function getDirectoryDisplayName(uri: string) {
  const normalized = uri.replace(/\/+$/, "");
  const segments = normalized.split("/");
  return decodeURIComponent(segments[segments.length - 1] || normalized);
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#06101d",
  },
  content: {
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 36,
    gap: 14,
  },
  headerCard: {
    width: "100%",
    backgroundColor: "#0d1b2e",
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  titleRow: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
    paddingTop: 4,
  },
  titleMark: {
    width: "100%",
    minWidth: 0,
  },
  titleMarkHeader: {
    maxWidth: 250,
  },
  titleMarkIntro: {
    alignItems: "center",
  },
  titleMarkAccent: {
    width: 82,
    height: 10,
    borderTopLeftRadius: 999,
    borderBottomRightRadius: 999,
    backgroundColor: "rgba(249, 115, 22, 0.9)",
    marginBottom: 8,
    transform: [{ rotate: "-8deg" }],
  },
  titleMarkAccentIntro: {
    width: 120,
    height: 12,
    marginBottom: 14,
  },
  titleGlyphWrap: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    transform: [{ rotate: "-2deg" }],
  },
  titleGlyphWrapIntro: {
    transform: [{ rotate: "-3deg" }],
  },
  titleGlyphRowIntro: {
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
  },
  titleGlyphText: {
    flex: 1,
    width: "100%",
    color: "#f8fafc",
    fontWeight: "900",
    fontStyle: "italic",
    letterSpacing: 0.6,
    includeFontPadding: false,
    textShadowColor: "rgba(8, 21, 39, 0.85)",
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 10,
    transform: [{ skewX: "-10deg" }],
  },
  titleGlyphTextHeader: {
    fontSize: 19,
    lineHeight: 22,
  },
  titleGlyphTextIntro: {
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: 1.2,
    textAlign: "center",
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#13304d",
    borderWidth: 1,
    borderColor: "rgba(125, 211, 252, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonText: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "800",
  },
  statsRow: {
    width: "100%",
    flexDirection: "row",
    gap: 10,
  },
  gameStage: {
    width: "100%",
    alignItems: "center",
    position: "relative",
  },
  stageCard: {
    width: "100%",
    borderRadius: 28,
    padding: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
    backgroundColor: "#0d1b2e",
    alignItems: "center",
  },
  statCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: "#0b1628",
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.14)",
    gap: 5,
  },
  openedStatCard: {
    flex: 1.55,
  },
  statLabel: {
    color: "#94a3b8",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  openedStatValuesRow: {
    flexDirection: "row",
    gap: 8,
  },
  statValueFrame: {
    flex: 1,
    minWidth: 0,
    borderRadius: 14,
    paddingVertical: 9,
    paddingHorizontal: 10,
    backgroundColor: "rgba(19, 48, 77, 0.62)",
    borderWidth: 1,
    borderColor: "rgba(125, 211, 252, 0.15)",
    gap: 2,
  },
  statValue: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "800",
    flexShrink: 1,
  },
  boardShell: {
    overflow: "hidden",
    borderRadius: 28,
    backgroundColor: "#14263f",
    borderWidth: 3,
    alignSelf: "center",
  },
  boardPhotoViewport: {
    ...StyleSheet.absoluteFillObject,
    overflow: "hidden",
    backgroundColor: "#14263f",
  },
  stageOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  spark: {
    position: "absolute",
    left: 0,
    top: 0,
    shadowColor: "#ffffff",
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  overlayBanner: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 16,
    borderRadius: 20,
    backgroundColor: "rgba(6, 16, 29, 0.9)",
    padding: 14,
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(103, 232, 249, 0.26)",
  },
  overlayTitle: {
    color: "#f8fafc",
    fontSize: 17,
    fontWeight: "800",
  },
  overlayText: {
    color: "#cbd5e1",
    fontSize: 13,
    lineHeight: 18,
  },
  overlayButton: {
    alignSelf: "flex-start",
    marginTop: 6,
    borderRadius: 12,
    backgroundColor: "#13304d",
    borderWidth: 1,
    borderColor: "rgba(125, 211, 252, 0.24)",
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  overlayButtonText: {
    color: "#f8fafc",
    fontSize: 13,
    fontWeight: "800",
  },
  controlsCard: {
    width: "100%",
    borderRadius: 24,
    backgroundColor: "#0d1b2e",
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
  },
  buttonGrid: {
    flexDirection: "row",
    gap: 10,
  },
  button: {
    borderRadius: 16,
    backgroundColor: "#13304d",
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "rgba(125, 211, 252, 0.2)",
    gap: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonStretch: {
    flex: 1,
  },
  buttonAuto: {
    alignSelf: "stretch",
    minHeight: 50,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonLabel: {
    color: "#f8fafc",
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  buttonCaption: {
    color: "#67e8f9",
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
  },
  buttonHelper: {
    color: "#94a3b8",
    fontSize: 11,
    lineHeight: 14,
    textAlign: "center",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.76)",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  modalCard: {
    borderRadius: 24,
    backgroundColor: "#0d1b2e",
    padding: 18,
    gap: 14,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
  },
  modalTitle: {
    color: "#f8fafc",
    fontSize: 20,
    fontWeight: "800",
  },
  modalBody: {
    gap: 8,
  },
  noticeCard: {
    alignItems: "center",
    gap: 12,
    paddingTop: 22,
  },
  noticeBadge: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(249, 115, 22, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(251, 146, 60, 0.45)",
  },
  noticeBadgeText: {
    color: "#fdba74",
    fontSize: 26,
    fontWeight: "900",
    textAlign: "center",
  },
  noticeBody: {
    color: "#d8e1eb",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  introBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.88)",
    paddingHorizontal: 18,
  },
  introBackdropContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingVertical: 24,
  },
  introCard: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    borderRadius: 28,
    backgroundColor: "#091426",
    padding: 20,
    gap: 14,
    borderWidth: 1,
    borderColor: "rgba(125, 211, 252, 0.18)",
  },
  previewShell: {
    width: "100%",
    aspectRatio: 1000 / 760,
    maxHeight: 210,
    minHeight: 150,
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "#132948",
  },
  helpLine: {
    color: "#d8e1eb",
    fontSize: 13,
    lineHeight: 18,
  },
  settingSection: {
    gap: 8,
  },
  settingTitle: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "700",
  },
  optionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderRadius: 16,
    backgroundColor: "#0b1628",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.14)",
  },
  optionRowActive: {
    borderColor: "rgba(103, 232, 249, 0.44)",
    backgroundColor: "#12314f",
  },
  optionRowText: {
    color: "#d8e1eb",
    fontSize: 14,
    fontWeight: "600",
  },
  optionRowTextActive: {
    color: "#ecfeff",
  },
  optionRowMarker: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "800",
  },
  sourceEmptyText: {
    color: "#94a3b8",
    fontSize: 13,
    lineHeight: 18,
  },
  sourceEntryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderRadius: 16,
    backgroundColor: "#0b1628",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.14)",
  },
  sourceEntryText: {
    flex: 1,
    color: "#d8e1eb",
    fontSize: 14,
    fontWeight: "600",
  },
  removeSourceButton: {
    borderRadius: 12,
    backgroundColor: "rgba(249, 115, 22, 0.14)",
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  removeSourceButtonText: {
    color: "#fdba74",
    fontSize: 12,
    fontWeight: "800",
  },
  addFolderButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: 16,
    backgroundColor: "#13304d",
    borderWidth: 1,
    borderColor: "rgba(125, 211, 252, 0.2)",
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  addFolderButtonPlus: {
    color: "#67e8f9",
    fontSize: 20,
    fontWeight: "800",
  },
  addFolderButtonText: {
    color: "#f8fafc",
    fontSize: 14,
    fontWeight: "700",
  },
  demoGlowLarge: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "rgba(103, 232, 249, 0.28)",
    top: 100,
    left: 40,
  },
  demoGlowSmall: {
    position: "absolute",
    width: 180,
    height: 180,
    borderRadius: 999,
    backgroundColor: "rgba(249, 115, 22, 0.35)",
    bottom: 82,
    right: 24,
  },
  demoStamp: {
    position: "absolute",
    right: 22,
    top: 24,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(6, 16, 29, 0.55)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.18)",
  },
  demoStampText: {
    color: "#f8fafc",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
});