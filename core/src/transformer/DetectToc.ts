import Item from '../Item';
import ItemResult from '../ItemResult';
import ItemTransformer from './ItemTransformer';
import TransformContext from './TransformContext';
import LineItemMerger from '../debug/LineItemMerger';
import { groupByLine, groupByPage, onlyUniques, transformGroupedByPage } from '../support/groupingUtils';
import { PAGE_MAPPING } from './CacluclateStatistics';
import { extractEndingNumber } from '../support/stringFunctions';
import ItemType from '../ItemType';
import { numbersAreConsecutive } from '../support/numberFunctions';

const config = {
  // How many characters a line with a ending number needs to have minimally to be a valid link
  linkMinLength: 5,
};

export default class DetectToc extends ItemTransformer {
  constructor() {
    super(
      'Detect TOC',
      'Detect table of contents.',
      {
        requireColumns: ['x', 'y', 'str', 'line'],
        debug: {
          itemMerger: new LineItemMerger(),
        },
      },
      (incomingSchema) => {
        return incomingSchema.reduce((schema, column) => {
          if (column === 'x') {
            return [...schema, 'types', 'x'];
          }
          return [...schema, column];
        }, new Array<string>());
      },
    );
  }

  transform(context: TransformContext, inputItems: Item[]): ItemResult {
    const pageMapping = context.getGlobal(PAGE_MAPPING);
    const maxPageToEvaluate = Math.min(context.pageCount / 2, 5 + Math.abs(pageMapping.pageFactor));
    const pagesToEvaluate = groupByPage(inputItems.filter((item) => item.page <= maxPageToEvaluate));
    const maxPageToBeLinkedTo = context.pageCount + pageMapping.pageFactor - 1;

    const tocArea = findTocArea(pagesToEvaluate, context.pageCount, maxPageToBeLinkedTo);

    if (!tocArea) {
      return { items: inputItems, messages: ['No Table of Contents found!'] };
    }

    const numbersByStartUuid = tocArea.linesWithNumbers.reduce((map: Map<string, number>, l) => {
      map.set(l.startItemUuid, l.number);
      return map;
    }, new Map());

    const itemsInTocArea = inputItems.filter((item) => tocArea.pages.includes(item.page));
    const itemsInTocAreaByLine = groupByLine(itemsInTocArea);

    const maxHeightOfNumberedLines = Math.max(
      ...itemsInTocAreaByLine
        .reduce((lineHeights: number[], lineItems) => {
          if (numbersByStartUuid.has(lineItems[0].uuid)) {
            lineHeights.push(Math.max(...lineItems.map((line) => line.data['height'])));
          }
          return lineHeights;
        }, [])
        .filter(onlyUniques),
    );
    const maxLinesBetweenLinesWithNumbers = Math.max(
      ...itemsInTocAreaByLine
        .reduce((distances: number[], lineItems) => {
          if (numbersByStartUuid.has(lineItems[0].uuid)) {
            distances.push(-1);
          }
          if (distances.length > 0) {
            distances[distances.length - 1]++;
          }
          return distances;
        }, [])
        .filter(onlyUniques),
    );

    let tocLines = 0;
    return {
      items: transformGroupedByPage(inputItems, (page, pageItems) => {
        if (!tocArea.pages.includes(page)) {
          return pageItems;
        }

        const itemsGroupedByLine = groupByLine(pageItems);
        const itemsToEmit: Item[] = [];
        itemsGroupedByLine
          .reduce((beforeLines: Item[][], currentLine) => {
            const number = numbersByStartUuid.get(currentLine[0].uuid);
            if (!number) {
              beforeLines.push(currentLine);
              return beforeLines;
            } else {
              beforeLines.forEach((beforLine, beforeIndex) => {
                const beforLineHeigth = Math.max(...beforLine.map((item) => item.data['height']));
                const beforeLineMuchLarger = beforLineHeigth > maxHeightOfNumberedLines;
                beforLine.forEach((item) => {
                  if (!beforeLineMuchLarger && beforeLines.length - beforeIndex <= maxLinesBetweenLinesWithNumbers) {
                    item = item.withDataAddition({ types: [ItemType.TOC] });
                    tocLines++;
                  }
                  itemsToEmit.push(item);
                });
              });
              currentLine.forEach((item) => itemsToEmit.push(item.withDataAddition({ types: [ItemType.TOC] })));
              tocLines++;
              return [];
            }
          }, [])
          .forEach((remainingItems) => remainingItems.forEach((item) => itemsToEmit.push(item)));
        //TODO Create Toc global
        //TODO re-order after y ?
        return itemsToEmit;
      }),
      messages: [`Detected ${tocLines} TOC lines`],
    };
  }
}

function findTocArea(pagesToEvaluate: Item[][], pageCount: number, maxPageToBeLinkedTo: number): TocArea | undefined {
  const linesWithNumber: LineWithNumber[] = [];
  pagesToEvaluate.forEach((pageItems) => {
    const itemsGroupedByLine = groupByLine(pageItems);
    itemsGroupedByLine.forEach((lineItems) => {
      const number = findEndingNumber(lineItems);
      if (
        number &&
        Number.isInteger(number) &&
        number > 0 &&
        number <= maxPageToBeLinkedTo &&
        lineItems.map((item) => item.data['str']).join('').length > config.linkMinLength
      ) {
        const page = lineItems[0].page;
        const startItemUuid = lineItems[0].uuid;
        linesWithNumber.push({ page, startItemUuid, number });
      }
    });
  });

  if (linesWithNumber.length <= 0) {
    return undefined;
  }

  const lineNumberClusters = linesWithNumber.reduce(
    (arrayOfAscendingNumberArrays: LineWithNumber[][], lineWithNumber) => {
      if (arrayOfAscendingNumberArrays.length == 0) {
        return [[lineWithNumber]];
      }
      const lastArray = arrayOfAscendingNumberArrays[arrayOfAscendingNumberArrays.length - 1];
      const lastNumber = lastArray[lastArray.length - 1];
      if (lineWithNumber.number >= lastNumber.number) {
        lastArray.push(lineWithNumber);
      } else {
        arrayOfAscendingNumberArrays.push([lineWithNumber]);
      }
      return arrayOfAscendingNumberArrays;
    },
    [],
  );

  lineNumberClusters.sort((a, b) => b.length - a.length);
  if (lineNumberClusters[0].length < 3) {
    return undefined;
  }

  const selectedLines = lineNumberClusters[0];
  const pages = selectedLines.map((l) => l.page).filter(onlyUniques);
  if (!numbersAreConsecutive(pages)) {
    return undefined;
  }
  if (pages.length > selectedLines.length / 5) {
    return undefined;
  }

  return {
    pages,
    linesWithNumbers: selectedLines,
  };
}

function findEndingNumber(lineItems: Item[]): number | undefined {
  const text = lineItems
    .reduce((text, item) => {
      return text + item.data['str'];
    }, '')
    .trim();
  return extractEndingNumber(text);
}

/**
 * Pointer to pages/items which classified as TOC.
 */
interface TocArea {
  pages: number[];
  linesWithNumbers: LineWithNumber[];
}

/**
 * A (item[]) line which ends with a number.
 */
interface LineWithNumber {
  page: number;
  startItemUuid: string;
  number: number;
}