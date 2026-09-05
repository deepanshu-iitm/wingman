import { randomInt } from 'node:crypto';

export const OPENING_QUESTIONS = [
  // Easy, concrete warm-ups
  'What would a genuinely fun evening with a friend look like for you?',
  'What is something you could happily talk about for hours with the right person?',
  'When was the last time a friend made you laugh really hard?',
  'What kind of plan would make you immediately want to join?',
  'What small thing can a friend do that always makes you feel appreciated?',
  'What usually makes you feel comfortable around someone new?',
  'What is something you would love to have a friend join you for?',
  'When you have a free afternoon, how do you most enjoy spending it?',
  'What kind of conversation makes you lose track of time?',
  'What is a simple moment with a friend that you remember fondly?',

  // Social rhythm
  'Do you feel most yourself one-on-one, in a small group, or in a lively crowd?',
  'After a tiring week, what kind of company helps you recharge?',
  'How spontaneous do you like your plans with friends to be?',
  'What does your ideal weekend with friends usually involve?',
  'Are you usually the person making plans or happily joining them?',
  'How often do you like hearing from a close friend?',
  'What makes a social plan feel energizing instead of exhausting?',
  'Would you choose a quiet café chat or a busy night out, and why?',
  'How do you usually act when you enter a group where you know nobody?',
  'What balance between social time and alone time works best for you?',

  // Interests and curiosity
  'What have you been unusually excited about lately?',
  'What hobby or interest brings out your most enthusiastic side?',
  'What is something new you would enjoy learning with a friend?',
  'Which movie, show, game, or book have you wanted to discuss with someone?',
  'What activity always improves your mood?',
  'What topic sends you down the best internet rabbit holes?',
  'If a friend planned a surprise day for you, what would you hope was included?',
  'What is one interest you wish more people around you shared?',
  'What could convince you to try an activity you have never done before?',
  'What is your favorite way to turn an ordinary day into a memorable one?',

  // Communication
  'What makes you feel truly heard in a conversation?',
  'When you are excited, how does it usually show in the way you talk?',
  'Do you enjoy playful teasing with friends, or prefer straightforward warmth?',
  'What kind of messages from a friend brighten your day?',
  'When you disagree with someone you care about, what helps the conversation?',
  'Do you prefer long conversations or lots of short check-ins?',
  'What makes someone especially easy for you to talk to?',
  'How do you normally show a friend that you are listening?',
  'What kind of humor do you connect with fastest?',
  'When something is bothering you, do you talk immediately or take time first?',

  // Values
  'What quality makes you respect someone almost immediately?',
  'What does being a reliable friend mean to you?',
  'Which matters more in friendship: honesty, kindness, loyalty, or something else?',
  'What is one value you hope your closest friends share?',
  'What behavior makes you trust someone over time?',
  'What is a friendship boundary that matters to you?',
  'When has a friend made you feel especially supported?',
  'What does loyalty look like in everyday friendship?',
  'What kind of generosity means the most to you?',
  'What makes you feel that someone genuinely cares?',

  // Friendship style
  'What role do you naturally take in your friend group?',
  'What makes a friendship feel low-pressure and easy?',
  'How do you usually support a friend who is having a rough day?',
  'What do your closest friends understand about you that others might miss?',
  'What is something you enjoy giving to a friendship?',
  'How do you like friends to celebrate your good news?',
  'What makes you want to keep getting to know someone?',
  'What kind of friend brings out the best version of you?',
  'How do you know when an acquaintance is becoming a real friend?',
  'What does a healthy amount of effort in friendship feel like to you?',

  // Plans and experiences
  'If you could plan a friend day anywhere nearby, what would you choose?',
  'Would you rather revisit a favorite place or explore somewhere completely new?',
  'What kind of trip would you actually enjoy taking with friends?',
  'What is your favorite kind of unplanned adventure?',
  'How detailed do plans need to be before you feel comfortable?',
  'What is one experience that becomes much better when shared?',
  'Would you rather host friends at home or meet somewhere outside?',
  'What is your favorite way to spend time together without spending much money?',
  'What plan sounds boring to others but perfect to you?',
  'What is something fun you keep meaning to organize with friends?',

  // Personality and energy
  'What side of your personality appears only around people you trust?',
  'What kind of person makes you feel more adventurous?',
  'When do you feel most playful around friends?',
  'Are you more often the calm friend, the chaotic friend, or somewhere between?',
  'What kind of energy do you enjoy being around?',
  'What makes you open up to someone?',
  'How would your closest friend describe your social personality?',
  'What is a harmless habit your friends would instantly recognize as yours?',
  'What makes you feel free to be completely yourself?',
  'Which version of you tends to appear at a really good hangout?',

  // Care and conflict
  'How can a friend best check in when you seem quiet?',
  'What helps you repair things after a misunderstanding?',
  'Do you prefer advice, reassurance, distraction, or simply company when stressed?',
  'How do you let someone know they crossed a line?',
  'What kind of apology feels sincere to you?',
  'When a friend is struggling, what do you naturally do first?',
  'How much space do you usually need after a disagreement?',
  'What makes difficult conversations feel safe enough to have?',
  'How do you prefer a friend to be honest with you?',
  'What is one way friends can make each other feel more secure?',

  // Meaningful connection
  'What would make a new friendship feel worth investing in?',
  'What is something you hope to experience more often with friends?',
  'What makes a friendship last even when life gets busy?',
  'What kind of memories do you most want to create with people?',
  'What is one thing you have learned from a great friendship?',
  'What makes you excited to see someone again?',
  'How would you describe the friendship you need most at this point in life?',
  'What does feeling close to someone mean to you?',
  'What is the nicest unexpected thing a friend has done for you?',
  'If you met the right new friend today, what would you hope you two clicked over?',
] as const;

export function randomOpeningQuestion(): string {
  return OPENING_QUESTIONS[randomInt(OPENING_QUESTIONS.length)] as string;
}
