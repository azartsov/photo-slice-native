import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { Directory, File, Paths } from "expo-file-system";
import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
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
import Svg, { Circle, G, Line, Polygon, Polyline, Rect } from "react-native-svg";

import {
  advanceGameState,
  createInitialGameState,
  getBoardSize,
  getCursorPosition,
  getCutTrail,
  getOpenPercent,
  HazardKind,
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
type AverageLevelDurationsMs = Record<DifficultyLevel, number>;

type LevelRewardState = {
  totalCoins: number;
  brightCoins: number;
  startedAtMs: number | null;
  baselineDurationMs: number;
};

type CoinVisualState = {
  index: number;
  eclipseProgress: number;
};

type CoinRewardFlight = {
  id: number;
  count: number;
  source: Vector2;
  target: Vector2;
  finalTotalCoins: number;
  openedPhotosByDifficulty: OpenedPhotosByDifficulty;
  averageLevelDurationsMs: AverageLevelDurationsMs;
};

type CoinSpendFlight = {
  id: number;
  count: number;
  source: Vector2;
  target: Vector2;
  finalTotalCoins: number;
};

type NoticeState = {
  title: string;
  body: string;
} | null;

type SoundEffect = "paper-rustle" | "hazard-clear" | "life-lost";

type AppStats = {
  openedPhotosCount?: number;
  openedPhotosByDifficulty?: Partial<OpenedPhotosByDifficulty>;
  musicMuted?: boolean;
  totalCoins?: number;
  averageLevelDurationsMs?: Partial<AverageLevelDurationsMs>;
  levelNumber?: number;
};

const MAX_FRAME_DELTA_SECONDS = 0.1;
const MIN_LEVEL_DURATION_MS = 9000;
const MAX_LEVEL_DURATION_MS = 270000;
const COIN_FADE_DURATION_MULTIPLIER = 3;
const COIN_TOKEN_SIZE = 28;
const LIFE_COST_COINS = 2;
const CAMERA_ALBUM_PATTERN = /(camera|камера|dcim)/i;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp"]);
const APP_STORAGE_DIRECTORY = new Directory(Paths.document, "random-photo-slice");
const APP_STATS_FILE = new File(APP_STORAGE_DIRECTORY, "stats.json");
const PAPER_RUSTLE_SOUND = require("../../assets/sfx/paper-rustle.wav");
const INTRO_MUSIC_TRACK = require("../../assets/audio/intro.m4a");
const GAME_MUSIC_TRACKS = [
  require("../../assets/audio/1.m4a"),
  require("../../assets/audio/2.m4a"),
  require("../../assets/audio/3.m4a"),
  require("../../assets/audio/4.m4a"),
  require("../../assets/audio/5.m4a"),
] as const;
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
const DEFAULT_LEVEL_DURATION_MS: AverageLevelDurationsMs = {
  sunny: 18000,
  cloudy: 26000,
  stormy: 34000,
  blizzard: 44000,
  apocalypse: 56000,
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
    hazardCount: 7,
    accent: "#020617",
    foreground: "#f8fafc",
  },
};

function waitForMilliseconds(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForAudioPlayerLoaded(player: { isLoaded: boolean }, timeoutMilliseconds = 2000) {
  const startedAt = Date.now();

  while (!player.isLoaded) {
    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error("audio player load timeout");
    }

    await waitForMilliseconds(25);
  }
}

async function primeAudioPlayer(player: {
  isLoaded: boolean;
  volume: number;
  play(): void;
  pause(): void;
  seekTo(seconds: number): Promise<void>;
}, durationSeconds?: number) {
  await waitForAudioPlayerLoaded(player);
  const originalVolume = player.volume;
  const warmUpMilliseconds = Math.max(140, Math.ceil((durationSeconds ?? 0.14) * 1000) + 30);

  player.volume = Math.min(originalVolume, 0.01);
  player.play();
  await waitForMilliseconds(warmUpMilliseconds);
  player.pause();
  await waitForMilliseconds(20);
  player.volume = originalVolume;
  await player.seekTo(0);
}

async function restartSoundEffectPlayer(player: {
  muted: boolean;
  playing: boolean;
  pause(): void;
  play(): void;
  seekTo(seconds: number): Promise<void>;
}) {
  player.muted = false;

  if (player.playing) {
    player.pause();
  }

  await player.seekTo(0);
  await waitForMilliseconds(30);

  player.play();
}

async function playPaperRustleSound() {
  const player = createAudioPlayer(PAPER_RUSTLE_SOUND);
  player.volume = 0.48;

  try {
    await waitForAudioPlayerLoaded(player, 1200);
    player.play();
    await waitForMilliseconds(Math.max(650, Math.ceil(player.duration * 1000) + 120));
  } catch (error) {
    console.warn("paper rustle playback failed", error);
  } finally {
    player.remove();
  }
}
const UI_TEXT = {
  ru: {
    title: "Random Photo Slice",
    level: "Уровень",
    totalCoins: "Монеты",
    rewardCoins: "Награда",
    coinsWon: "Монеты в копилку",
    opened: "Открыто",
    hazards: "Враги",
    lives: "Жизни",
    wonTitle: "Фото полностью раскрыто",
    wonBody: "Все шурикены уничтожены. Оставшиеся яркие монеты ушли в копилку, а следующий уровень уже станет сложнее.",
    lostTitle: "Фото не удалось открыть",
    lostBody: "Все жизни закончились. Монеты этого уровня сгорели. Нажмите Играть, чтобы заново пройти тот же уровень.",
    playButton: "Играть",
    nextLevelHint: "Следующий по кругу",
    currentRewardHint: "Тускнеют по ходу уровня",
    readyTitle: "Уровень готов",
    readyBody: "Нажмите Играть, чтобы начать попытку.",
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
      "1. Тап по полю запускает разрез, следующие тапы поворачивают его на 90°.",
      "2. Откройте область без шурикенов, чтобы уничтожить их. Контакт с линией отнимает жизнь.",
      "3. Уровни повторяют пять уровней сложности, а номер уровня показывает общий прогресс.",
      "4. За победу всегда дается 1 монета. Песочные часы показывают бонус за скорость: от +1 на первом уровне до +5 на пятом.",
      "5. Когда песок закончился, бонус исчезает, но гарантированная монета остается.",
      "6. Кнопка + у Жизней тратит 2 монеты из копилки и добавляет одну жизнь.",
    ],
    difficultyLegendTitle: "Сложности",
    difficultyDescriptions: {
      sunny: "Солнечный: 3 шурикена",
      cloudy: "Облачный: 4 шурикена",
      stormy: "Штормовой: 5 шурикенов",
      blizzard: "Ураганный: 6 шурикенов",
      apocalypse: "Апокалипсис: 7 шурикенов",
    },
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
    level: "Level",
    totalCoins: "Coins",
    rewardCoins: "Reward",
    coinsWon: "Banked coins",
    opened: "Opened",
    hazards: "Enemies",
    lives: "Lives",
    wonTitle: "Photo fully revealed",
    wonBody: "All shurikens are gone. The bright coins were banked and the next level is already tougher.",
    lostTitle: "Photo could not be revealed",
    lostBody: "No lives left. This level's coins are gone. Press Play to retry the same level.",
    playButton: "Play",
    nextLevelHint: "Next in loop",
    currentRewardHint: "Dims during the run",
    readyTitle: "Level ready",
    readyBody: "Press Play to start the run.",
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
      "1. Tap the board to launch a cut; further taps turn it by 90 degrees.",
      "2. Reveal an area without shurikens to clear them. A shuriken touching the cut costs a life.",
      "3. Five difficulty levels repeat while the level number shows your overall progress.",
      "4. Every win gives 1 coin. The hourglass shows a speed bonus, from +1 on level one to +5 on level five.",
      "5. When the sand runs out, the bonus ends but the guaranteed coin remains.",
      "6. The + button by Lives spends 2 banked coins to add one life.",
    ],
    difficultyLegendTitle: "Difficulty levels",
    difficultyDescriptions: {
      sunny: "Sunny: 3 shurikens",
      cloudy: "Cloudy: 4 shurikens",
      stormy: "Stormy: 5 shurikens",
      blizzard: "Blizzard: 6 shurikens",
      apocalypse: "Apocalypse: 7 shurikens",
    },
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
  const [difficulty, setDifficulty] = useState<DifficultyLevel>("sunny");
  const [gameState, setGameState] = useState<PhotoSliceGameState>(() => createGameStateForLevel("sunny", 1));
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
  const [musicMuted, setMusicMuted] = useState(false);
  const [musicPreferenceLoaded, setMusicPreferenceLoaded] = useState(false);
  const [audioSessionReady, setAudioSessionReady] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [bursts, setBursts] = useState<SparkBurst[]>([]);
  const [levelNumber, setLevelNumber] = useState(1);
  const [totalCoins, setTotalCoins] = useState(0);
  const [lastWonCoins, setLastWonCoins] = useState(0);
  const [coinRewardFlight, setCoinRewardFlight] = useState<CoinRewardFlight | null>(null);
  const [coinSpendFlight, setCoinSpendFlight] = useState<CoinSpendFlight | null>(null);
  const [rewardClockMs, setRewardClockMs] = useState(() => Date.now());
  const [averageLevelDurationsMs, setAverageLevelDurationsMs] = useState<AverageLevelDurationsMs>(DEFAULT_LEVEL_DURATION_MS);
  const [levelReward, setLevelReward] = useState<LevelRewardState>(() => createLevelRewardState("sunny", DEFAULT_LEVEL_DURATION_MS));
  const [openedPhotosByDifficulty, setOpenedPhotosByDifficulty] = useState<OpenedPhotosByDifficulty>(EMPTY_OPENED_PHOTOS_BY_DIFFICULTY);
  const [openedLayout, setOpenedLayout] = useState<LayoutBox | null>(null);
  const [boardLayout, setBoardLayout] = useState<LayoutBox | null>(null);
  const [hazardsLayout, setHazardsLayout] = useState<LayoutBox | null>(null);
  const [livesLayout, setLivesLayout] = useState<LayoutBox | null>(null);
  const boardShellRef = useRef<View | null>(null);
  const rewardCardRef = useRef<View | null>(null);
  const totalCoinsBadgeRef = useRef<View | null>(null);
  const livesCardRef = useRef<View | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const attemptedInitialPhotoRef = useRef(false);
  const eventNonceRef = useRef(0);
  const burstIdRef = useRef(1);
  const previousStatusRef = useRef(gameState.status);
  const previousOpenPercentRef = useRef<number | null>(null);
  const previousOpenedPhotosCountRef = useRef<number | null>(null);
  const pendingSoundQueueRef = useRef<SoundEffect[]>([]);
  const soundReplayTasksRef = useRef<Record<SoundEffect, Promise<void>>>({
    "paper-rustle": Promise.resolve(),
    "hazard-clear": Promise.resolve(),
    "life-lost": Promise.resolve(),
  });
  const audioPrimedRef = useRef(false);
  const currentHazardPlayerIndexRef = useRef(0);
  const currentLifeLostPlayerIndexRef = useRef(0);
  const currentGameTrackIndexRef = useRef(0);
  const hazardClearPlayerA = useAudioPlayer(require("../../assets/sfx/hazard-clear.wav"), { downloadFirst: true, keepAudioSessionActive: true });
  const hazardClearPlayerB = useAudioPlayer(require("../../assets/sfx/hazard-clear.wav"), { downloadFirst: true, keepAudioSessionActive: true });
  const lifeLostPlayerA = useAudioPlayer(require("../../assets/sfx/life-lost-electric.wav"), { downloadFirst: true, keepAudioSessionActive: true });
  const lifeLostPlayerB = useAudioPlayer(require("../../assets/sfx/life-lost-electric.wav"), { downloadFirst: true, keepAudioSessionActive: true });
  const introMusicPlayer = useAudioPlayer(INTRO_MUSIC_TRACK, { downloadFirst: true, keepAudioSessionActive: true });
  const gameMusicPlayer = useAudioPlayer(GAME_MUSIC_TRACKS[0], { downloadFirst: true, keepAudioSessionActive: true });
  const hazardClearStatusA = useAudioPlayerStatus(hazardClearPlayerA);
  const hazardClearStatusB = useAudioPlayerStatus(hazardClearPlayerB);
  const lifeLostStatusA = useAudioPlayerStatus(lifeLostPlayerA);
  const lifeLostStatusB = useAudioPlayerStatus(lifeLostPlayerB);
  const introMusicStatus = useAudioPlayerStatus(introMusicPlayer);
  const gameMusicStatus = useAudioPlayerStatus(gameMusicPlayer);
  const openedScale = useRef(new Animated.Value(1)).current;
  const hazardsScale = useRef(new Animated.Value(1)).current;
  const livesScale = useRef(new Animated.Value(1)).current;
  const totalCoinsScale = useRef(new Animated.Value(1)).current;
  const boardSizePx = useMemo(() => Math.max(260, Math.min(dimensions.width - 56, dimensions.height * 0.56)), [dimensions.height, dimensions.width]);
  const difficultyTheme = DIFFICULTY_THEMES[difficulty];

  useEffect(() => {
    hazardClearPlayerA.muted = false;
    hazardClearPlayerA.volume = 0.5;
    hazardClearPlayerB.muted = false;
    hazardClearPlayerB.volume = 0.5;
    lifeLostPlayerA.muted = false;
    lifeLostPlayerA.volume = 0.74;
    lifeLostPlayerB.muted = false;
    lifeLostPlayerB.volume = 0.74;
    introMusicPlayer.volume = 0.62;
    introMusicPlayer.loop = true;
    gameMusicPlayer.volume = 0.48;
    gameMusicPlayer.loop = false;
  }, [gameMusicPlayer, hazardClearPlayerA, hazardClearPlayerB, introMusicPlayer, lifeLostPlayerA, lifeLostPlayerB]);

  useEffect(() => {
    if (
      audioPrimedRef.current ||
      !audioSessionReady ||
      !hazardClearStatusA.isLoaded ||
      !hazardClearStatusB.isLoaded ||
      !lifeLostStatusA.isLoaded ||
      !lifeLostStatusB.isLoaded
    ) {
      return;
    }

    audioPrimedRef.current = true;
    void (async () => {
      await primeAudioPlayer(hazardClearPlayerA, hazardClearStatusA.duration);
      await primeAudioPlayer(hazardClearPlayerB, hazardClearStatusB.duration);
      await primeAudioPlayer(lifeLostPlayerA, lifeLostStatusA.duration);
      await primeAudioPlayer(lifeLostPlayerB, lifeLostStatusB.duration);
    })()
      .then(() => {
        setAudioReady(true);
      })
      .catch((error) => {
        console.warn("audio prime failed", error);
      });
  }, [
    audioSessionReady,
    hazardClearPlayerA,
    hazardClearPlayerB,
    hazardClearStatusA.duration,
    hazardClearStatusA.isLoaded,
    hazardClearStatusB.duration,
    hazardClearStatusB.isLoaded,
    lifeLostPlayerA,
    lifeLostPlayerB,
    lifeLostStatusA.duration,
    lifeLostStatusA.isLoaded,
    lifeLostStatusB.duration,
    lifeLostStatusB.isLoaded,
  ]);

  useEffect(() => {
    if (pendingSoundQueueRef.current.length === 0) {
      return;
    }

    const pendingEffects = pendingSoundQueueRef.current;
    pendingSoundQueueRef.current = [];

    for (const effect of pendingEffects) {
      queueSound(effect);
    }
  }, [audioReady, hazardClearStatusA.isLoaded, hazardClearStatusB.isLoaded, lifeLostStatusA.isLoaded, lifeLostStatusB.isLoaded]);

  useEffect(() => {
    let cancelled = false;

    async function prepareAudio() {
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: false,
          interruptionMode: "duckOthers",
          shouldRouteThroughEarpiece: false,
        });

        if (cancelled) {
          return;
        }

        await setIsAudioActiveAsync(true);

        if (cancelled) {
          return;
        }

        setAudioSessionReady(true);
      } catch (error) {
        console.warn("audio init failed", error);
      }
    }

    void prepareAudio();

    return () => {
      cancelled = true;
      setAudioReady(false);
      setAudioSessionReady(false);
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
    if (!attemptStarted || gameState.status !== "playing") {
      return;
    }

    let frameId = 0;
    const updateRewardClock = () => {
      setRewardClockMs(Date.now());
      frameId = requestAnimationFrame(updateRewardClock);
    };

    frameId = requestAnimationFrame(updateRewardClock);
    return () => cancelAnimationFrame(frameId);
  }, [attemptStarted, gameState.status]);

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

  useEffect(() => {
    if (introVisible) {
      if (gameMusicPlayer.playing) {
        gameMusicPlayer.pause();
      }

      currentGameTrackIndexRef.current = 0;
      try {
        gameMusicPlayer.replace(GAME_MUSIC_TRACKS[0]);
      } catch (error) {
        console.warn("game music reset failed", error);
      }
      void gameMusicPlayer.seekTo(0).catch(() => undefined);
      return;
    }

    if (introMusicPlayer.playing) {
      introMusicPlayer.pause();
    }
    void introMusicPlayer.seekTo(0).catch(() => undefined);

    currentGameTrackIndexRef.current = 0;
    try {
      gameMusicPlayer.replace(GAME_MUSIC_TRACKS[0]);
    } catch (error) {
      console.warn("game music replace failed", error);
    }
  }, [gameMusicPlayer, introMusicPlayer, introVisible]);

  useEffect(() => {
    if (!musicPreferenceLoaded) {
      return;
    }

    if (musicMuted) {
      if (introMusicPlayer.playing) {
        introMusicPlayer.pause();
      }

      if (gameMusicPlayer.playing) {
        gameMusicPlayer.pause();
      }
      return;
    }

    if (introVisible) {
      if (gameMusicPlayer.playing) {
        gameMusicPlayer.pause();
      }

      if (introMusicStatus.isLoaded && !introMusicStatus.playing) {
        introMusicPlayer.play();
      }
      return;
    }

    if (introMusicPlayer.playing) {
      introMusicPlayer.pause();
    }

    if (gameMusicStatus.isLoaded && !gameMusicStatus.playing) {
      gameMusicPlayer.play();
    }
  }, [
    gameMusicPlayer,
    gameMusicStatus.isLoaded,
    gameMusicStatus.playing,
    introMusicPlayer,
    introMusicStatus.isLoaded,
    introMusicStatus.playing,
    introVisible,
    musicMuted,
    musicPreferenceLoaded,
  ]);

  useEffect(() => {
    if (!gameMusicStatus.didJustFinish || introVisible) {
      return;
    }

    const nextTrackIndex = (currentGameTrackIndexRef.current + 1) % GAME_MUSIC_TRACKS.length;
    currentGameTrackIndexRef.current = nextTrackIndex;

    try {
      gameMusicPlayer.replace(GAME_MUSIC_TRACKS[nextTrackIndex]);
    } catch (error) {
      console.warn("game music advance failed", error);
    }
  }, [gameMusicPlayer, gameMusicStatus.didJustFinish, introVisible]);

  const cursor = getCursorPosition(gameState);
  const cutTrail = gameState.activeCut ? getCutTrail(gameState.activeCut) : null;
  const openPercent = getOpenPercent(gameState);
  const hazardsLeft = gameState.hazards.length;
  const copy = UI_TEXT[language];
  const openedPhotosCount = openedPhotosByDifficulty[difficulty];
  const currentLevelCoins = getVisibleBrightCoins(levelReward, averageLevelDurationsMs[difficulty], openPercent, attemptStarted, gameState.status);
  const levelBonusCoins = Math.max(0, currentLevelCoins - 1);
  const maxLevelBonusCoins = Math.max(0, levelReward.totalCoins - 1);
  const sandProgress = getHourglassSandProgress(levelReward, averageLevelDurationsMs[difficulty], attemptStarted, gameState.status, rewardClockMs);
  const nextDifficulty = getNextDifficulty(difficulty);
  const canPressPlay = !loadingPhoto && !attemptStarted;

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
      const completedLevel = difficulty;
      const remainingCoins = getVisibleBrightCoins(levelReward, averageLevelDurationsMs[completedLevel], openPercent, true, "playing");
      const completionDurationMs = getCompletionDurationMs(levelReward, averageLevelDurationsMs[completedLevel]);
      const nextCounts = {
        ...openedPhotosByDifficulty,
        [completedLevel]: openedPhotosByDifficulty[completedLevel] + 1,
      };
      const nextAverageDurations = updateAverageLevelDurations(averageLevelDurationsMs, completedLevel, completionDurationMs);
      const nextTotalCoins = totalCoins + remainingCoins;

      setWonOverlayDismissed(false);
      setOpenedPhotosByDifficulty(nextCounts);
      setAverageLevelDurationsMs(nextAverageDurations);
      setLastWonCoins(remainingCoins);
      setLevelReward((current) => ({
        ...current,
        brightCoins: remainingCoins,
        startedAtMs: null,
      }));

      if (!remainingCoins || !rewardCardRef.current || !totalCoinsBadgeRef.current) {
        setTotalCoins(nextTotalCoins);
        void persistAppStats(nextCounts, musicMuted, nextTotalCoins, nextAverageDurations);
      } else {
        rewardCardRef.current.measureInWindow((sourceX, sourceY, sourceWidth, sourceHeight) => {
          totalCoinsBadgeRef.current?.measureInWindow((targetX, targetY, targetWidth, targetHeight) => {
            if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
              setTotalCoins(nextTotalCoins);
              void persistAppStats(nextCounts, musicMuted, nextTotalCoins, nextAverageDurations);
              return;
            }

            setCoinRewardFlight({
              id: Date.now(),
              count: remainingCoins,
              source: { x: sourceX + sourceWidth / 2, y: sourceY + sourceHeight / 2 },
              target: { x: targetX + targetWidth / 2, y: targetY + targetHeight / 2 },
              finalTotalCoins: nextTotalCoins,
              openedPhotosByDifficulty: nextCounts,
              averageLevelDurationsMs: nextAverageDurations,
            });
          });
        });
      }
    }

    if (previousStatusRef.current !== "lost" && gameState.status === "lost") {
      setLevelReward((current) => ({
        ...current,
        brightCoins: 0,
        startedAtMs: null,
      }));
    }

    if (gameState.status === "won" || gameState.status === "lost") {
      setAttemptStarted(false);
    }

    if (gameState.status !== "won") {
      setWonOverlayDismissed(false);
    }

    previousStatusRef.current = gameState.status;
  }, [averageLevelDurationsMs, difficulty, gameState.status, levelReward, musicMuted, openPercent, openedPhotosByDifficulty, totalCoins]);

  useEffect(() => {
    if (!attemptStarted && gameState.status === "playing") {
      setGameState(createGameStateForLevel(difficulty, levelNumber));
      setBursts([]);
      setLevelReward(createLevelRewardState(difficulty, averageLevelDurationsMs));
    }
  }, [attemptStarted, averageLevelDurationsMs, difficulty, gameState.status, levelNumber]);

  useEffect(() => {
    if (previousOpenPercentRef.current == null) {
      previousOpenPercentRef.current = openPercent;
      return;
    }

    if (openPercent > previousOpenPercentRef.current) {
      triggerOpenedFeedback("opened-progress", Math.max(1, openPercent - previousOpenPercentRef.current));
      queueSound("paper-rustle");
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
        setMusicMuted(false);
        setMusicPreferenceLoaded(true);
        return;
      }

      const raw = await APP_STATS_FILE.text();
      const parsed = JSON.parse(raw) as AppStats;

      setMusicMuted(parsed.musicMuted ?? false);
      setTotalCoins(parsed.totalCoins ?? 0);
      setAverageLevelDurationsMs(mergeAverageDurations(parsed.averageLevelDurationsMs));

      const savedLevelNumber = parsed.levelNumber;
      if (typeof savedLevelNumber === "number" && Number.isInteger(savedLevelNumber) && savedLevelNumber >= 1) {
        const savedDifficulty = getDifficultyForLevel(savedLevelNumber);
        setDifficulty(savedDifficulty);
        setLevelNumber(savedLevelNumber);
        setGameState(createGameStateForLevel(savedDifficulty, savedLevelNumber));
        setLevelReward(createLevelRewardState(savedDifficulty, mergeAverageDurations(parsed.averageLevelDurationsMs)));
      }

      if (parsed.openedPhotosByDifficulty) {
        setOpenedPhotosByDifficulty({
          sunny: parsed.openedPhotosByDifficulty.sunny ?? 0,
          cloudy: parsed.openedPhotosByDifficulty.cloudy ?? 0,
          stormy: parsed.openedPhotosByDifficulty.stormy ?? 0,
          blizzard: parsed.openedPhotosByDifficulty.blizzard ?? 0,
          apocalypse: parsed.openedPhotosByDifficulty.apocalypse ?? 0,
        });
        setMusicPreferenceLoaded(true);
        return;
      }

      if (Number.isFinite(parsed.openedPhotosCount)) {
        setOpenedPhotosByDifficulty({
          ...EMPTY_OPENED_PHOTOS_BY_DIFFICULTY,
          stormy: parsed.openedPhotosCount ?? 0,
        });
        setMusicPreferenceLoaded(true);
        return;
      }

      setOpenedPhotosByDifficulty(EMPTY_OPENED_PHOTOS_BY_DIFFICULTY);
      setMusicPreferenceLoaded(true);
    } catch (error) {
      console.warn("could not load app stats", error);
      setOpenedPhotosByDifficulty(EMPTY_OPENED_PHOTOS_BY_DIFFICULTY);
      setTotalCoins(0);
      setAverageLevelDurationsMs(DEFAULT_LEVEL_DURATION_MS);
      setMusicMuted(false);
      setMusicPreferenceLoaded(true);
    }
  }

  async function persistOpenedPhotosCount(nextCounts: OpenedPhotosByDifficulty) {
    await persistAppStats(nextCounts, musicMuted, totalCoins, averageLevelDurationsMs);
  }

  async function persistAppStats(
    nextCounts: OpenedPhotosByDifficulty,
    nextMusicMuted: boolean,
    nextTotalCoins: number,
    nextAverageDurations: AverageLevelDurationsMs,
    nextLevelNumber = levelNumber,
  ) {
    try {
      if (!APP_STORAGE_DIRECTORY.exists) {
        APP_STORAGE_DIRECTORY.create({ idempotent: true, intermediates: true });
      }

      if (!APP_STATS_FILE.exists) {
        APP_STATS_FILE.create({ intermediates: true, overwrite: true });
      }

      APP_STATS_FILE.write(
        JSON.stringify({
          openedPhotosByDifficulty: nextCounts,
          musicMuted: nextMusicMuted,
          totalCoins: nextTotalCoins,
          averageLevelDurationsMs: nextAverageDurations,
          levelNumber: nextLevelNumber,
        }),
      );
    } catch (error) {
      console.warn("could not persist app stats", error);
    }
  }

  function toggleMusicMuted() {
    setMusicMuted((current) => {
      const next = !current;
      void persistAppStats(openedPhotosByDifficulty, next, totalCoins, averageLevelDurationsMs);
      return next;
    });
  }

  function buyLife() {
    if (totalCoins < LIFE_COST_COINS || gameState.status !== "playing" || coinSpendFlight) {
      return;
    }

    const nextTotalCoins = totalCoins - LIFE_COST_COINS;
    if (!totalCoinsBadgeRef.current || !livesCardRef.current) {
      setTotalCoins(nextTotalCoins);
      setGameState((current) => (current.status === "playing" ? { ...current, lives: current.lives + 1 } : current));
      void persistAppStats(openedPhotosByDifficulty, musicMuted, nextTotalCoins, averageLevelDurationsMs);
      return;
    }

    totalCoinsBadgeRef.current.measureInWindow((sourceX, sourceY, sourceWidth, sourceHeight) => {
      livesCardRef.current?.measureInWindow((targetX, targetY, targetWidth, targetHeight) => {
        if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
          setTotalCoins(nextTotalCoins);
          setGameState((current) => (current.status === "playing" ? { ...current, lives: current.lives + 1 } : current));
          void persistAppStats(openedPhotosByDifficulty, musicMuted, nextTotalCoins, averageLevelDurationsMs);
          return;
        }

        setCoinSpendFlight({
          id: Date.now(),
          count: LIFE_COST_COINS,
          source: { x: sourceX + sourceWidth / 2, y: sourceY + sourceHeight / 2 },
          target: { x: targetX + targetWidth / 2, y: targetY + targetHeight / 2 },
          finalTotalCoins: nextTotalCoins,
        });
      });
    });
  }

  async function handleRandomPhoto(startAttempt = false, nextDifficulty = difficulty, nextLevelNumber = levelNumber) {
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
        setGameState(createGameStateForLevel(nextDifficulty, nextLevelNumber));
        setLevelReward(createLevelRewardState(nextDifficulty, averageLevelDurationsMs, startAttempt));
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
      setGameState(createGameStateForLevel(nextDifficulty, nextLevelNumber));
      setLevelReward(createLevelRewardState(nextDifficulty, averageLevelDurationsMs, startAttempt));
      setAttemptStarted(startAttempt);
    } catch (error) {
      setPhoto({
        uri: null,
        label: copy.demoLabel,
        width: null,
        height: null,
      });
      setBursts([]);
      setGameState(createGameStateForLevel(nextDifficulty, nextLevelNumber));
      setLevelReward(createLevelRewardState(nextDifficulty, averageLevelDurationsMs, startAttempt));
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
    setGameState(createGameStateForLevel(difficulty, levelNumber));
    setBursts([]);
    setLevelReward(createLevelRewardState(difficulty, averageLevelDurationsMs));
    setAttemptStarted(false);
  }

  async function handlePlayPress() {
    if (!canPressPlay) {
      return;
    }

    if (gameState.status === "won") {
      const upcomingDifficulty = getNextDifficulty(difficulty);
      const upcomingLevelNumber = levelNumber + 1;
      setDifficulty(upcomingDifficulty);
      setLevelNumber(upcomingLevelNumber);
      await persistAppStats(openedPhotosByDifficulty, musicMuted, totalCoins, averageLevelDurationsMs, upcomingLevelNumber);
      await handleRandomPhoto(true, upcomingDifficulty, upcomingLevelNumber);
      return;
    }

    setBursts([]);
    setGameState(createGameStateForLevel(difficulty, levelNumber));
    setLevelReward(createLevelRewardState(difficulty, averageLevelDurationsMs, true));
    setAttemptStarted(true);
  }

  function queueSound(effect: SoundEffect) {
    if (!audioReady) {
      pendingSoundQueueRef.current.push(effect);
      return;
    }

    if (effect === "life-lost") {
      playLifeLostSoundImmediate();
      return;
    }

    if (effect === "paper-rustle") {
      void playPaperRustleSound();
      return;
    }

    const nextHazardPlayerIndex = currentHazardPlayerIndexRef.current;
    const player = nextHazardPlayerIndex === 0 ? hazardClearPlayerA : hazardClearPlayerB;
    if (!player.isLoaded) {
      pendingSoundQueueRef.current.push(effect);
      return;
    }

    if (effect === "hazard-clear") {
      currentHazardPlayerIndexRef.current = nextHazardPlayerIndex === 0 ? 1 : 0;
    }

    soundReplayTasksRef.current[effect] = soundReplayTasksRef.current[effect]
      .catch(() => undefined)
      .then(async () => {
        try {
          await restartSoundEffectPlayer(player);
        } catch (error) {
          console.warn("sound playback failed", error);
        }
      });
  }

  function playLifeLostSoundImmediate() {
    const nextLifeLostPlayerIndex = currentLifeLostPlayerIndexRef.current;
    const player = nextLifeLostPlayerIndex === 0 ? lifeLostPlayerA : lifeLostPlayerB;

    if (!audioReady || !player.isLoaded) {
      pendingSoundQueueRef.current.push("life-lost");
      return;
    }

    currentLifeLostPlayerIndexRef.current = nextLifeLostPlayerIndex === 0 ? 1 : 0;

    soundReplayTasksRef.current["life-lost"] = soundReplayTasksRef.current["life-lost"]
      .catch(() => undefined)
      .then(async () => {
        try {
          await restartSoundEffectPlayer(player);
        } catch (error) {
          console.warn("life lost playback failed", error);
        }
      });
  }

  function handleGameEvent(event: PhotoSliceGameEvent) {
    const targetLayout = event.type === "life-lost" ? livesLayout : hazardsLayout;
    const targetScale = event.type === "life-lost" ? livesScale : hazardsScale;

    if (event.type === "life-lost") {
      pulseCounter(targetScale);
      Vibration.vibrate([0, 44, 26, 52, 24, 68]);
      playLifeLostSoundImmediate();
    } else {
      queueSound("hazard-clear");
      pulseCounter(targetScale);
    }

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
              <MusicToggleButton muted={musicMuted} onPress={toggleMusicMuted} />
              <IconButton label="?" onPress={() => setHelpVisible(true)} />
              <IconButton label="⚙" onPress={() => setSettingsVisible(true)} />
            </View>
          </View>
          <View style={styles.metaRow}>
            <View style={styles.levelBadge}>
              <Text style={styles.levelBadgeLabel}>{copy.level}</Text>
              <Text style={styles.levelBadgeValue}>{levelNumber}</Text>
              <View style={styles.levelDifficultyIcon}>
                <DifficultyWeatherIcon difficulty={difficulty} size={48} />
              </View>
            </View>
            <View ref={totalCoinsBadgeRef} style={styles.totalCoinsBadge}>
              <Text style={styles.totalCoinsLabel}>{copy.totalCoins}</Text>
              <Animated.Text style={[styles.totalCoinsValue, { transform: [{ scale: totalCoinsScale }] }]}>{totalCoins}</Animated.Text>
              <View ref={rewardCardRef} style={styles.hourglassReward}>
                <Hourglass sandProgress={sandProgress} running={attemptStarted && gameState.status === "playing"} />
                <Text style={styles.hourglassBonusText}>+{levelBonusCoins}</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.gameStage}>
          <Pressable style={styles.stageCard} onPress={(event) => handleStagePress(event.nativeEvent.pageX, event.nativeEvent.pageY)}>
            <View style={styles.statsRow}>
              <StatCard
                label={copy.opened}
                value={`${openPercent}%`}
                scale={openedScale}
                onLayout={captureLayout(setOpenedLayout)}
                accentColor="#67e8f9"
                allowValueResize={false}
              />
              <StatCard label={copy.hazards} value={String(hazardsLeft)} scale={hazardsScale} onLayout={captureLayout(setHazardsLayout)} accentColor="#fde047" />
              <StatCard
                targetRef={livesCardRef}
                label={copy.lives}
                value={String(gameState.lives)}
                scale={livesScale}
                onLayout={captureLayout(setLivesLayout)}
                accentColor="#67e8f9"
                actionLabel="+"
                actionDisabled={totalCoins < LIFE_COST_COINS || gameState.status !== "playing" || Boolean(coinSpendFlight)}
                onAction={buyLife}
              />
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
                    <Polygon points={buildShurikenPoints(hazard.position, hazard.radius)} fill={getHazardColors(hazard.kind).fill} stroke={getHazardColors(hazard.kind).stroke} strokeWidth="5" />
                    <Circle cx={hazard.position.x} cy={hazard.position.y} r={hazard.radius * 0.28} fill={getHazardColors(hazard.kind).center} />
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
                  <Text style={styles.winCoinsText}>{copy.coinsWon}: +{lastWonCoins}</Text>
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
          <ActionButton
            label={loadingPhoto ? copy.loading : copy.playButton}
            accentColor={difficultyTheme.accent}
            textColor={difficultyTheme.foreground}
            onPress={() => void handlePlayPress()}
            disabled={!canPressPlay}
          />
        </View>

      </ScrollView>

      {coinRewardFlight ? (
        <CoinRewardFlightLayer
          flight={coinRewardFlight}
          onCoinArrive={() => {
            setTotalCoins((current) => current + 1);
            pulseCounter(totalCoinsScale);
          }}
          onComplete={() => {
            void persistAppStats(
              coinRewardFlight.openedPhotosByDifficulty,
              musicMuted,
              coinRewardFlight.finalTotalCoins,
              coinRewardFlight.averageLevelDurationsMs,
            );
            setCoinRewardFlight(null);
          }}
        />
      ) : null}

      {coinSpendFlight ? (
        <CoinSpendFlightLayer
          flight={coinSpendFlight}
          onComplete={() => {
            setTotalCoins((current) => current - coinSpendFlight.count);
            pulseCounter(totalCoinsScale);
            setGameState((current) => (current.status === "playing" ? { ...current, lives: current.lives + 1 } : current));
            pulseCounter(livesScale);
            void persistAppStats(openedPhotosByDifficulty, musicMuted, coinSpendFlight.finalTotalCoins, averageLevelDurationsMs);
            setCoinSpendFlight(null);
          }}
        />
      ) : null}

      <OverlaySheet
        visible={helpVisible}
        title={copy.helpTitle}
        onClose={() => setHelpVisible(false)}
        closeLabel={copy.close}
        extraAction={<MusicToggleButton muted={musicMuted} onPress={toggleMusicMuted} />}
      >
        {copy.helpLines.map((line) => (
          <Text key={line} style={styles.helpLine}>
            {line}
          </Text>
        ))}
        <View style={styles.difficultyLegend}>
          <Text style={styles.difficultyLegendTitle}>{copy.difficultyLegendTitle}</Text>
          {DIFFICULTY_ORDER.map((difficultyLevel) => (
            <View key={difficultyLevel} style={styles.difficultyLegendRow}>
              <DifficultyWeatherIcon difficulty={difficultyLevel} size={36} />
              <Text style={styles.difficultyLegendText}>{copy.difficultyDescriptions[difficultyLevel]}</Text>
            </View>
          ))}
        </View>
      </OverlaySheet>

      <OverlaySheet
        visible={settingsVisible}
        title={copy.settingsTitle}
        onClose={() => setSettingsVisible(false)}
        closeLabel={copy.close}
        extraAction={<MusicToggleButton muted={musicMuted} onPress={toggleMusicMuted} />}
      >
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

      <NoticeDialog
        visible={notice != null}
        title={notice?.title ?? ""}
        body={notice?.body ?? ""}
        closeLabel={copy.close}
        onClose={() => setNotice(null)}
        extraAction={<MusicToggleButton muted={musicMuted} onPress={toggleMusicMuted} />}
      />

      <Modal animationType="fade" transparent visible={introVisible} onRequestClose={() => setIntroVisible(false)}>
        <ScrollView
          style={styles.introBackdrop}
          contentContainerStyle={styles.introBackdropContent}
          bounces={false}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.introCard}>
            <View style={styles.introHeaderRow}>
              <View style={styles.introHeaderSpacer} />
              <MusicToggleButton muted={musicMuted} onPress={toggleMusicMuted} />
            </View>
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
  extraAction,
}: {
  visible: boolean;
  title: string;
  body: string;
  closeLabel: string;
  onClose: () => void;
  extraAction?: React.ReactNode;
}) {
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={[styles.modalCard, styles.noticeCard]} onPress={() => undefined}>
          {extraAction ? <View style={styles.modalHeaderRow}>{extraAction}</View> : null}
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
      <View
        accessibilityLabel={title}
        accessible
        style={[styles.titleGlyphWrap, isIntro ? styles.titleGlyphWrapIntro : null]}
      >
        <Text numberOfLines={1} style={[styles.titleGlyphText, isIntro ? styles.titleGlyphTextIntro : styles.titleGlyphTextHeader]}>
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
  extraAction,
  children,
}: {
  visible: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  extraAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <View style={styles.modalTitleRow}>
            <Text style={styles.modalTitle}>{title}</Text>
            {extraAction}
          </View>
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

function MusicToggleButton({ muted, onPress }: { muted: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.iconButton} onPress={onPress}>
      <View style={styles.musicToggleIconWrap}>
        <Text style={styles.musicToggleIconText}>♪</Text>
        {muted ? <View style={styles.musicToggleSlash} /> : null}
      </View>
    </Pressable>
  );
}

function Hourglass({ sandProgress, running }: { sandProgress: number; running: boolean }) {
  const flip = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    flip.setValue(0);
    if (running) {
      Animated.sequence([
        Animated.timing(flip, { toValue: 1, duration: 260, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(flip, { toValue: 0, duration: 260, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }),
      ]).start();
    }
  }, [flip, running]);

  const rotation = flip.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] });
  const upperSandProgress = 1 - sandProgress;
  const upperSandTop = 15 - 11 * upperSandProgress;
  const upperSandHalfWidth = 1 + 7 * upperSandProgress;
  const lowerSandTop = 28 - 12.5 * sandProgress;
  const lowerSandHalfWidth = 8 - 6.5 * sandProgress;

  return (
    <Animated.View style={[styles.hourglass, { transform: [{ rotate: rotation }] }]}>
      <Svg width="34" height="42" viewBox="0 0 26 32">
        <Polygon points="3,2 23,2 16.5,15.5 23,30 3,30 9.5,15.5" fill="#10233c" stroke="#fde68a" strokeWidth="2" strokeLinejoin="round" />
        <Polygon points={`${13 - upperSandHalfWidth},${upperSandTop} ${13 + upperSandHalfWidth},${upperSandTop} 14.5,15 11.5,15`} fill="#facc15" opacity="0.92" />
        <Polygon points={`${13 - lowerSandHalfWidth},${lowerSandTop} ${13 + lowerSandHalfWidth},${lowerSandTop} 21,28 5,28`} fill="#facc15" opacity="0.92" />
        <Rect x="2" y="0" width="22" height="3" rx="1.5" fill="#fff5ea" />
        <Rect x="2" y="29" width="22" height="3" rx="1.5" fill="#fff5ea" />
      </Svg>
    </Animated.View>
  );
}

function StatCard({
  targetRef,
  label,
  value,
  scale,
  onLayout,
  accentColor,
  allowValueResize = true,
  actionLabel,
  actionDisabled = false,
  onAction,
}: {
  targetRef?: RefObject<View | null>;
  label: string;
  value: string;
  scale?: Animated.Value;
  onLayout?: (event: LayoutChangeEvent) => void;
  accentColor?: string;
  allowValueResize?: boolean;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  const Container = scale ? Animated.View : View;
  return (
    <Container ref={targetRef} style={[styles.statCard, scale ? { transform: [{ scale }] } : null, accentColor ? { borderColor: `${accentColor}33` } : null]} onLayout={onLayout}>
      <Text style={styles.statLabel}>{label}</Text>
      <View style={styles.statValueRow}>
        <View style={[styles.statValueFrame, accentColor ? { borderColor: `${accentColor}26` } : null]}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit={allowValueResize}
            minimumFontScale={allowValueResize ? 0.68 : undefined}
            style={[styles.statValue, accentColor ? { color: accentColor } : null]}
          >
            {value}
          </Text>
        </View>
        {actionLabel && onAction ? (
          <Pressable
            accessibilityLabel="Add a life for two coins"
            disabled={actionDisabled}
            hitSlop={6}
            onPress={(event) => {
              event.stopPropagation();
              onAction();
            }}
            style={[styles.statActionButton, actionDisabled ? styles.statActionButtonDisabled : null]}
          >
            <Text style={[styles.statActionButtonText, actionDisabled ? styles.statActionButtonTextDisabled : null]}>{actionLabel}</Text>
          </Pressable>
        ) : null}
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

function CoinRewardFlightLayer({
  flight,
  onCoinArrive,
  onComplete,
}: {
  flight: CoinRewardFlight;
  onCoinArrive: () => void;
  onComplete: () => void;
}) {
  const [coinIndex, setCoinIndex] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const onCoinArriveRef = useRef(onCoinArrive);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCoinArriveRef.current = onCoinArrive;
    onCompleteRef.current = onComplete;
  }, [onCoinArrive, onComplete]);

  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(0);

    Animated.sequence([
      Animated.delay(coinIndex === 0 ? 420 : 220),
      Animated.timing(progress, {
        toValue: 1,
        duration: 780,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished) {
        return;
      }

      onCoinArriveRef.current();
      if (coinIndex + 1 === flight.count) {
        onCompleteRef.current();
      } else {
        setCoinIndex((current) => current + 1);
      }
    });

    return () => progress.stopAnimation();
  }, [coinIndex, flight.count, progress]);

  const deltaX = flight.target.x - flight.source.x;
  const deltaY = flight.target.y - flight.source.y;
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, deltaX] });
  const translateY = progress.interpolate({ inputRange: [0, 0.58, 1], outputRange: [0, deltaY - 72, deltaY] });
  const scale = progress.interpolate({ inputRange: [0, 0.12, 0.8, 1], outputRange: [0.7, 1.2, 0.9, 0.35] });
  const opacity = progress.interpolate({ inputRange: [0, 0.08, 0.84, 1], outputRange: [0, 1, 1, 0] });

  return (
    <View pointerEvents="none" style={styles.coinRewardFlightLayer}>
      <Animated.View
        style={[
          styles.coinRewardFlightToken,
          {
            left: flight.source.x - COIN_TOKEN_SIZE / 2,
            top: flight.source.y - COIN_TOKEN_SIZE / 2,
            opacity,
            transform: [{ translateX }, { translateY }, { scale }],
          },
        ]}
      >
        <LinearGradient
          colors={["#fff7b0", "#facc15", "#d97706"]}
          start={{ x: 0.18, y: 0.08 }}
          end={{ x: 0.82, y: 0.95 }}
          style={[styles.coinToken, styles.coinTokenBright]}
        >
          <View style={styles.coinTokenRim} />
          <View style={styles.coinTokenInnerRing} />
          <View style={styles.coinTokenShine} />
        </LinearGradient>
      </Animated.View>
    </View>
  );
}

function CoinSpendFlightLayer({
  flight,
  onComplete,
}: {
  flight: CoinSpendFlight;
  onComplete: () => void;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(0);

    Animated.sequence([
      Animated.delay(140),
      Animated.timing(progress, {
        toValue: 1,
        duration: 620,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished) {
        return;
      }

      onCompleteRef.current();
    });

    return () => progress.stopAnimation();
  }, [progress]);

  const deltaX = flight.target.x - flight.source.x;
  const deltaY = flight.target.y - flight.source.y;
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, deltaX] });
  const translateY = progress.interpolate({ inputRange: [0, 0.52, 1], outputRange: [0, deltaY - 54, deltaY] });
  const scale = progress.interpolate({ inputRange: [0, 0.12, 0.82, 1], outputRange: [0.7, 1.16, 0.88, 0.35] });
  const opacity = progress.interpolate({ inputRange: [0, 0.08, 0.84, 1], outputRange: [0, 1, 1, 0] });

  return (
    <View pointerEvents="none" style={styles.coinRewardFlightLayer}>
      {Array.from({ length: flight.count }, (_, index) => (
        <Animated.View
          key={index}
          style={[
            styles.coinRewardFlightToken,
            {
              left: flight.source.x - COIN_TOKEN_SIZE / 2 + (index - (flight.count - 1) / 2) * 13,
              top: flight.source.y - COIN_TOKEN_SIZE / 2,
              opacity,
              transform: [{ translateX }, { translateY }, { scale }],
            },
          ]}
        >
          <LinearGradient
            colors={["#fff7b0", "#facc15", "#d97706"]}
            start={{ x: 0.18, y: 0.08 }}
            end={{ x: 0.82, y: 0.95 }}
            style={[styles.coinToken, styles.coinTokenBright]}
          >
            <View style={styles.coinTokenRim} />
            <View style={styles.coinTokenInnerRing} />
            <View style={styles.coinTokenShine} />
          </LinearGradient>
        </Animated.View>
      ))}
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

function DifficultyWeatherIcon({ difficulty, size = 48 }: { difficulty: DifficultyLevel; size?: number }) {
  const isDarkCloud = difficulty === "stormy" || difficulty === "blizzard" || difficulty === "apocalypse";
  const cloudFill = isDarkCloud ? "#1e293b" : "#f8fafc";
  const cloudStroke = isDarkCloud ? "#e2e8f0" : "#ffffff";
  const rainColor = difficulty === "apocalypse" ? "#60a5fa" : "#38bdf8";

  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      {difficulty === "sunny" || difficulty === "cloudy" || difficulty === "stormy" ? (
        <>
          <Circle cx="18" cy="18" r="8" fill="#facc15" />
          <Line x1="18" y1="3" x2="18" y2="7" stroke="#fde68a" strokeWidth="3" strokeLinecap="round" />
          <Line x1="28.6" y1="7.4" x2="25.8" y2="10.2" stroke="#fde68a" strokeWidth="3" strokeLinecap="round" />
          <Line x1="33" y1="18" x2="29" y2="18" stroke="#fde68a" strokeWidth="3" strokeLinecap="round" />
          <Line x1="28.6" y1="28.6" x2="25.8" y2="25.8" stroke="#fde68a" strokeWidth="3" strokeLinecap="round" />
          <Line x1="18" y1="33" x2="18" y2="29" stroke="#fde68a" strokeWidth="3" strokeLinecap="round" />
          <Line x1="7.4" y1="28.6" x2="10.2" y2="25.8" stroke="#fde68a" strokeWidth="3" strokeLinecap="round" />
          <Line x1="3" y1="18" x2="7" y2="18" stroke="#fde68a" strokeWidth="3" strokeLinecap="round" />
          <Line x1="7.4" y1="7.4" x2="10.2" y2="10.2" stroke="#fde68a" strokeWidth="3" strokeLinecap="round" />
        </>
      ) : null}
      {difficulty !== "sunny" ? (
        <>
          <Circle cx="18" cy="26" r="9" fill={cloudFill} stroke={cloudStroke} strokeWidth="1.5" />
          <Circle cx="28" cy="22" r="11" fill={cloudFill} stroke={cloudStroke} strokeWidth="1.5" />
          <Circle cx="36" cy="28" r="7" fill={cloudFill} stroke={cloudStroke} strokeWidth="1.5" />
          <Rect x="10" y="26" width="33" height="9" rx="4.5" fill={cloudFill} stroke={cloudStroke} strokeWidth="1.5" />
        </>
      ) : null}
      {difficulty === "blizzard" || difficulty === "apocalypse" ? (
        <>
          <Rect x="16" y="37" width="3" height="8" rx="1.5" fill={rainColor} transform="rotate(18 17.5 41)" />
          <Rect x="27" y="37" width="3" height="8" rx="1.5" fill={rainColor} transform="rotate(18 28.5 41)" />
          <Rect x="37" y="37" width="3" height="8" rx="1.5" fill={rainColor} transform="rotate(18 38.5 41)" />
        </>
      ) : null}
      {difficulty === "apocalypse" ? <Polygon points="25,35 19,44 25,44 22,48 33,38 27,38 30,35" fill="#facc15" /> : null}
    </Svg>
  );
}

function getNextDifficulty(level: DifficultyLevel) {
  const currentIndex = DIFFICULTY_ORDER.indexOf(level);
  return DIFFICULTY_ORDER[(currentIndex + 1) % DIFFICULTY_ORDER.length];
}

function getDifficultyForLevel(levelNumber: number) {
  return DIFFICULTY_ORDER[(levelNumber - 1) % DIFFICULTY_ORDER.length];
}

function createGameStateForLevel(level: DifficultyLevel, levelNumber: number) {
  const hazardCount = DIFFICULTY_THEMES[level].hazardCount;
  return createInitialGameState(hazardCount, getHazardKindsForLevel(levelNumber, hazardCount));
}

function getHazardKindsForLevel(levelNumber: number, hazardCount: number): HazardKind[] {
  const cycle = Math.floor((levelNumber - 1) / DIFFICULTY_ORDER.length) + 1;
  const specialHazards =
    cycle === 1
      ? []
      : cycle === 2
        ? ["red"]
        : cycle === 3
          ? ["red", "green"]
          : cycle === 4
            ? ["red", "red", "green"]
            : cycle === 5
              ? ["red", "green", "green"]
              : cycle === 6
                ? ["green", "green", "green"]
                : cycle === 7
                  ? Array(4).fill("green")
                  : cycle === 8
                    ? Array(5).fill("green")
                    : Array(hazardCount).fill("green");

  return [...specialHazards.slice(0, hazardCount), ...Array(Math.max(0, hazardCount - specialHazards.length)).fill("normal")] as HazardKind[];
}

function getHazardColors(kind: HazardKind) {
  switch (kind) {
    case "red":
      return { fill: "#ff1744", stroke: "#fff1f2", center: "#ffffff" };
    case "green":
      return { fill: "#00e676", stroke: "#d1fae5", center: "#ffffff" };
    default:
      return { fill: "#f97316", stroke: "#fff5ea", center: "#fff8ef" };
  }
}

function getLevelCoinCount(level: DifficultyLevel) {
  return DIFFICULTY_ORDER.indexOf(level) + 2;
}

function mergeAverageDurations(partial?: Partial<AverageLevelDurationsMs>): AverageLevelDurationsMs {
  return {
    sunny: clampLevelDuration(partial?.sunny ?? DEFAULT_LEVEL_DURATION_MS.sunny),
    cloudy: clampLevelDuration(partial?.cloudy ?? DEFAULT_LEVEL_DURATION_MS.cloudy),
    stormy: clampLevelDuration(partial?.stormy ?? DEFAULT_LEVEL_DURATION_MS.stormy),
    blizzard: clampLevelDuration(partial?.blizzard ?? DEFAULT_LEVEL_DURATION_MS.blizzard),
    apocalypse: clampLevelDuration(partial?.apocalypse ?? DEFAULT_LEVEL_DURATION_MS.apocalypse),
  };
}

function createLevelRewardState(level: DifficultyLevel, averageDurations: AverageLevelDurationsMs, startAttempt = false): LevelRewardState {
  const totalCoins = getLevelCoinCount(level);
  return {
    totalCoins,
    brightCoins: totalCoins,
    startedAtMs: startAttempt ? Date.now() : null,
    baselineDurationMs: averageDurations[level],
  };
}

function getCoinVisualStates(
  reward: LevelRewardState,
  averageDurationMs: number,
  openPercent: number,
  attemptStarted: boolean,
  status: PhotoSliceGameState["status"],
  nowMs: number,
): CoinVisualState[] {
  const eclipseProgresses = getCoinEclipseProgresses(reward, averageDurationMs, openPercent, attemptStarted, status, nowMs);
  return eclipseProgresses.map((eclipseProgress, index) => ({
    index,
    eclipseProgress,
  }));
}

function getVisibleBrightCoins(
  reward: LevelRewardState,
  averageDurationMs: number,
  openPercent: number,
  attemptStarted: boolean,
  status: PhotoSliceGameState["status"],
) {
  if (!attemptStarted || status !== "playing" || reward.startedAtMs == null) {
    return reward.brightCoins;
  }

  const elapsedMs = Math.max(0, Date.now() - reward.startedAtMs);
  const targetDurationMs = getCoinFadeDurationMs(reward.baselineDurationMs || averageDurationMs);
  const bonusCoins = Math.max(0, reward.totalCoins - 1);
  const fadeIntervalMs = Math.max(2400, targetDurationMs / Math.max(bonusCoins, 1));
  return 1 + Math.max(0, bonusCoins - Math.floor(elapsedMs / fadeIntervalMs));
}

function getHourglassSandProgress(
  reward: LevelRewardState,
  averageDurationMs: number,
  attemptStarted: boolean,
  status: PhotoSliceGameState["status"],
  nowMs: number,
) {
  if (!attemptStarted || status !== "playing" || reward.startedAtMs == null) {
    return 0;
  }

  const targetDurationMs = getCoinFadeDurationMs(reward.baselineDurationMs || averageDurationMs);
  return Math.min(1, Math.max(0, (nowMs - reward.startedAtMs) / targetDurationMs));
}

function getCoinEclipseProgresses(
  reward: LevelRewardState,
  averageDurationMs: number,
  openPercent: number,
  attemptStarted: boolean,
  status: PhotoSliceGameState["status"],
  nowMs: number,
) {
  if (!attemptStarted || status !== "playing" || reward.startedAtMs == null) {
    const visibleCoins = reward.brightCoins;
    return Array.from({ length: reward.totalCoins }, (_, index) => (index < visibleCoins ? 0 : 1));
  }

  const elapsedMs = Math.max(0, nowMs - reward.startedAtMs);
  const targetDurationMs = getCoinFadeDurationMs(reward.baselineDurationMs || averageDurationMs);
  const fadeIntervalMs = Math.max(2400, targetDurationMs / reward.totalCoins);

  return Array.from({ length: reward.totalCoins }, (_, index) => {
    const startedFadingAtMs = fadeIntervalMs * index;
    return Math.min(1, Math.max(0, (elapsedMs - startedFadingAtMs) / fadeIntervalMs));
  });
}

function getCoinFadeDurationMs(averageDurationMs: number) {
  return clampLevelDuration(averageDurationMs * COIN_FADE_DURATION_MULTIPLIER);
}

function getAdaptiveTargetDurationMs(baseDurationMs: number, elapsedMs: number, openPercent: number) {
  if (openPercent < 8) {
    return clampLevelDuration(baseDurationMs);
  }

  const paceProjectionMs = (elapsedMs / Math.max(openPercent, 1)) * 100;
  return clampLevelDuration(baseDurationMs * 0.62 + paceProjectionMs * 0.38);
}

function getCompletionDurationMs(reward: LevelRewardState, fallbackMs: number) {
  if (reward.startedAtMs == null) {
    return fallbackMs;
  }

  return clampLevelDuration(Date.now() - reward.startedAtMs);
}

function updateAverageLevelDurations(
  current: AverageLevelDurationsMs,
  completedDifficulty: DifficultyLevel,
  completionDurationMs: number,
): AverageLevelDurationsMs {
  return {
    ...current,
    [completedDifficulty]: clampLevelDuration(current[completedDifficulty] * 0.7 + completionDurationMs * 0.3),
  };
}

function clampLevelDuration(value: number) {
  return Math.round(Math.min(MAX_LEVEL_DURATION_MS, Math.max(MIN_LEVEL_DURATION_MS, value)));
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
  metaRow: {
    marginTop: 14,
    flexDirection: "row",
    gap: 10,
  },
  levelBadge: {
    flex: 1.2,
    minWidth: 0,
    minHeight: 78,
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 14,
    position: "relative",
    backgroundColor: "#0b1628",
    borderWidth: 1,
    borderColor: "rgba(249, 115, 22, 0.26)",
    gap: 2,
  },
  levelBadgeLabel: {
    color: "#94a3b8",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  levelBadgeValue: {
    color: "#f8fafc",
    fontSize: 28,
    fontWeight: "900",
  },
  levelDifficultyIcon: {
    position: "absolute",
    right: 10,
    bottom: 8,
  },
  totalCoinsBadge: {
    flex: 1,
    minWidth: 0,
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: "#111d12",
    borderWidth: 1,
    borderColor: "rgba(250, 204, 21, 0.26)",
    justifyContent: "flex-start",
    gap: 2,
  },
  totalCoinsLabel: {
    color: "#94a3b8",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  totalCoinsValue: {
    color: "#fde047",
    fontSize: 28,
    fontWeight: "900",
  },
  hourglassReward: {
    position: "absolute",
    right: 8,
    bottom: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  hourglass: {
    width: 34,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  hourglassBonusText: {
    color: "#fde68a",
    fontSize: 13,
    fontWeight: "900",
    fontVariant: ["tabular-nums"],
  },
  rewardCard: {
    marginTop: 10,
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "#0b1628",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.14)",
    alignItems: "center",
  },
  coinRow: {
    flexDirection: "row",
    gap: 10,
  },
  coinTokenShell: {
    width: COIN_TOKEN_SIZE,
    height: COIN_TOKEN_SIZE,
    borderRadius: COIN_TOKEN_SIZE / 2,
    overflow: "hidden",
    position: "relative",
  },
  coinTokenSourceHidden: {
    opacity: 0,
  },
  coinToken: {
    width: COIN_TOKEN_SIZE,
    height: COIN_TOKEN_SIZE,
    borderRadius: COIN_TOKEN_SIZE / 2,
    overflow: "hidden",
  },
  coinTokenBright: {
    borderWidth: 2,
    borderColor: "#fff5b8",
  },
  coinTokenRim: {
    position: "absolute",
    inset: 3,
    borderRadius: (COIN_TOKEN_SIZE - 6) / 2,
    borderWidth: 2,
    borderColor: "rgba(146, 64, 14, 0.48)",
  },
  coinTokenInnerRing: {
    position: "absolute",
    inset: 7,
    borderRadius: (COIN_TOKEN_SIZE - 14) / 2,
    borderWidth: 1,
    borderColor: "rgba(255, 251, 235, 0.76)",
  },
  coinTokenShine: {
    position: "absolute",
    width: 9,
    height: 5,
    top: 4,
    left: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.78)",
    transform: [{ rotate: "-32deg" }],
  },
  coinTokenEclipse: {
    position: "absolute",
    height: COIN_TOKEN_SIZE,
    top: 0,
    left: 0,
    borderTopRightRadius: COIN_TOKEN_SIZE / 2,
    borderBottomRightRadius: COIN_TOKEN_SIZE / 2,
  },
  coinTokenDim: {
    backgroundColor: "#2b3548",
    borderColor: "rgba(148, 163, 184, 0.3)",
  },
  coinRewardFlightLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
  },
  coinRewardFlightToken: {
    position: "absolute",
    width: COIN_TOKEN_SIZE,
    height: COIN_TOKEN_SIZE,
    shadowColor: "#facc15",
    shadowOpacity: 0.85,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 10,
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
  titleGlyphWrap: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    minWidth: 0,
  },
  titleGlyphWrapIntro: {
    width: "auto",
    justifyContent: "center",
  },
  titleGlyphText: {
    color: "#fb923c",
    fontFamily: "cursive",
    fontWeight: "300",
    fontStyle: "italic",
    letterSpacing: 0.4,
    includeFontPadding: false,
    textShadowColor: "rgba(255, 245, 234, 0.48)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  titleGlyphTextHeader: {
    fontSize: 23,
    lineHeight: 26,
  },
  titleGlyphTextIntro: {
    fontSize: 38,
    lineHeight: 42,
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
  musicToggleIconWrap: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  musicToggleIconText: {
    color: "#f8fafc",
    fontSize: 24,
    lineHeight: 24,
    fontWeight: "900",
  },
  musicToggleSlash: {
    position: "absolute",
    width: 28,
    height: 3,
    borderRadius: 999,
    backgroundColor: "#fb923c",
    transform: [{ rotate: "-40deg" }],
    shadowColor: "#000000",
    shadowOpacity: 0.35,
    shadowRadius: 2,
  },
  statsRow: {
    width: "100%",
    flexDirection: "row",
    gap: 7,
  },
  gameStage: {
    width: "100%",
    alignItems: "center",
    position: "relative",
  },
  stageCard: {
    width: "100%",
    borderRadius: 28,
    padding: 8,
    gap: 8,
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
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.14)",
    gap: 3,
  },
  statLabel: {
    color: "#94a3b8",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  statValueFrame: {
    flex: 1,
    minWidth: 0,
    borderRadius: 11,
    paddingVertical: 5,
    paddingHorizontal: 6,
    backgroundColor: "rgba(19, 48, 77, 0.62)",
    borderWidth: 1,
    borderColor: "rgba(125, 211, 252, 0.15)",
    gap: 2,
  },
  statValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  statValue: {
    color: "#f8fafc",
    fontSize: 20,
    fontWeight: "800",
    flexShrink: 1,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  statActionButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0e7490",
    borderWidth: 1,
    borderColor: "#67e8f9",
    shadowColor: "#67e8f9",
    shadowOpacity: 0.34,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 1 },
  },
  statActionButtonDisabled: {
    backgroundColor: "#162235",
    borderColor: "rgba(100, 116, 139, 0.55)",
    borderStyle: "dashed",
    shadowOpacity: 0,
  },
  statActionButtonText: {
    color: "#f8fafc",
    fontSize: 18,
    lineHeight: 20,
    fontWeight: "900",
  },
  statActionButtonTextDisabled: {
    color: "#64748b",
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
  winCoinsText: {
    color: "#fde047",
    fontSize: 16,
    fontWeight: "900",
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
  modalTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  modalHeaderRow: {
    width: "100%",
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  modalTitle: {
    color: "#f8fafc",
    fontSize: 20,
    fontWeight: "800",
    flex: 1,
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
  introHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  introHeaderSpacer: {
    flex: 1,
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
  difficultyLegend: {
    gap: 6,
    paddingTop: 4,
  },
  difficultyLegendTitle: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "700",
  },
  difficultyLegendRow: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  difficultyLegendText: {
    color: "#d8e1eb",
    flexShrink: 1,
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