import 'dotenv/config';
import { evalite } from 'evalite';
import { mastra } from '../index';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

async function llmJudge(
  question: string,
  response: string,
  criteria: string
): Promise<number> {
  const result = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: `You are evaluating the quality of a running coach AI response.

Question asked: ${question}

Coach response: ${response}

Evaluation criteria: ${criteria}

Score the response from 0 to 1 where:
- 1.0 = fully meets the criteria
- 0.5 = partially meets the criteria  
- 0.0 = does not meet the criteria

Respond with ONLY a number between 0 and 1. Nothing else.`,
      },
    ],
  });

  const score = parseFloat(
    (result.content[0] as { type: string; text: string }).text.trim()
  );
  return isNaN(score) ? 0 : score;
}

evalite('Running Coach Evals', {
  data: async () => [
    {
      input: 'How have my last few runs been?',
      expected: 'tool_called',
    },
    {
      input: 'Am I overtraining?',
      expected: 'training_load_tool_called',
    },
    {
      input: 'What should I eat for breakfast?',
      expected: 'no_tool_needed',
    },
  ],

  task: async (input: string) => {
    const agent = mastra.getAgent('weatherAgent');
    const result = await agent.generate(input);

    const toolsCalled = result.steps
      .flatMap((step: any) => step.toolCalls || [])
      .map((tc: any) => tc.payload?.toolName || tc.toolName);

    return {
      text: result.text,
      toolsCalled,
      input,
    };
  },

  scorers: [
    {
      name: 'Correct tool selected',
      scorer: ({ output, expected }: any) => {
        if (expected === 'tool_called') {
          return output.toolsCalled.length > 0 ? 1 : 0;
        }
        if (expected === 'training_load_tool_called') {
          return output.toolsCalled.includes('getTrainingLoadTool') ? 1 : 0;
        }
        if (expected === 'no_tool_needed') {
          return output.toolsCalled.length === 0 ? 1 : 0;
        }
        return 0;
      },
    },
    {
      name: 'Response quality',
      scorer: async ({ output }: any) => {
        const criteria: Record<string, string> = {
          'How have my last few runs been?':
            'The response references specific data like dates, distances, paces or heart rates. It does not give generic advice. It draws a conclusion from the data.',
          'Am I overtraining?':
            'The response gives a clear yes or no answer. It references specific data to justify the conclusion. It does not hedge excessively.',
          'What should I eat for breakfast?':
            'The response stays within the scope of a running coach. It does not give detailed nutrition advice outside its remit. It is brief.',
        };

        const criterion = criteria[output.input];
        if (!criterion) return 0;

        return await llmJudge(output.input, output.text, criterion);
      },
    },
  ],
});